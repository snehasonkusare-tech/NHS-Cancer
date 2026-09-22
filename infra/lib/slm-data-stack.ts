import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';

export class SlmDataStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Raw source data (the two workbooks). Private, encrypted, TLS-only.
    const dataBucket = new s3.Bucket(this, 'DataBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Aurora needs a VPC; the RDS Data API is reached over HTTPS so no NAT/endpoints are needed.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
    });

    const cluster = new rds.DatabaseCluster(this, 'PatientDb', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_17_9 }),
      credentials: rds.Credentials.fromGeneratedSecret('slm_admin'),
      defaultDatabaseName: 'nhs_slm',
      writer: rds.ClusterInstance.serverlessV2('writer'),
      serverlessV2MinCapacity: 0.5, // stays warm: no cold resume on first request
      serverlessV2MaxCapacity: 2,
      enableDataApi: true,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      storageEncrypted: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    // Managed OpenSearch domain (single small node) for the NG12 knowledge base with kNN.
    // Access is SigV4-only for principals in this account; grant the Lambda role es:ESHttp* via IAM.
    const domain = new opensearch.Domain(this, 'KnowledgeBase', {
      version: opensearch.EngineVersion.OPENSEARCH_2_17,
      capacity: { dataNodes: 1, dataNodeInstanceType: 't3.small.search', multiAzWithStandbyEnabled: false },
      ebs: { volumeSize: 10, volumeType: ec2.EbsDeviceVolumeType.GP3 },
      encryptionAtRest: { enabled: true },
      nodeToNodeEncryption: true,
      enforceHttps: true,
      accessPolicies: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [new iam.AccountRootPrincipal()],
          actions: ['es:ESHttp*'],
          resources: [`arn:${this.partition}:es:${this.region}:${this.account}:domain/*/*`],
        }),
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---- Chat API: API Gateway -> Lambda -> Aurora + OpenSearch + model ----
    // Model backend is chosen at deploy time: -c sagemakerEndpoint=<name>  or  -c bedrockModelId=<id>
    const sagemakerEndpoint = this.node.tryGetContext('sagemakerEndpoint') ?? '';
    const bedrockModelId = this.node.tryGetContext('bedrockModelId') ?? '';

    const chatFn = new lambda.Function(this, 'ChatFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset('lambda'),
      timeout: cdk.Duration.seconds(29), // API Gateway's hard limit
      memorySize: 512,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        DB_CLUSTER_ARN: cluster.clusterArn,
        DB_SECRET_ARN: cluster.secret!.secretArn,
        DB_NAME: 'nhs_slm',
        OPENSEARCH_ENDPOINT: domain.domainEndpoint,
        OPENSEARCH_INDEX: 'nhs-ng12-kb',
        SAGEMAKER_ENDPOINT: sagemakerEndpoint,
        BEDROCK_MODEL_ID: bedrockModelId,
      },
    });
    cluster.grantDataApiAccess(chatFn);
    cluster.secret!.grantRead(chatFn);
    domain.grantReadWrite(chatFn);
    chatFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:${this.partition}:bedrock:*::foundation-model/*`,
        `arn:${this.partition}:bedrock:*:${this.account}:inference-profile/*`,
      ],
    }));
    if (sagemakerEndpoint) {
      chatFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['sagemaker:InvokeEndpoint'],
        resources: [`arn:${this.partition}:sagemaker:${this.region}:${this.account}:endpoint/${sagemakerEndpoint}`],
      }));
    }

    const api = new apigw.RestApi(this, 'ChatApi', {
      restApiName: 'nhs-cancer-pathway-chat',
      deployOptions: { stageName: 'prod', throttlingRateLimit: 5, throttlingBurstLimit: 10 },
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'x-api-key'],
      },
    });
    api.root.addResource('chat').addMethod('POST', new apigw.LambdaIntegration(chatFn), { apiKeyRequired: true });
    const apiKey = api.addApiKey('ChatApiKey');
    const plan = api.addUsagePlan('ChatUsagePlan', {
      throttle: { rateLimit: 5, burstLimit: 10 },
      quota: { limit: 5000, period: apigw.Period.DAY },
      apiStages: [{ api, stage: api.deploymentStage }],
    });
    plan.addApiKey(apiKey);

    new cdk.CfnOutput(this, 'ChatApiUrl', { value: `${api.url}chat` });
    new cdk.CfnOutput(this, 'ChatApiKeyId', { value: apiKey.keyId });

    new cdk.CfnOutput(this, 'DataBucketName', { value: dataBucket.bucketName });
    new cdk.CfnOutput(this, 'DbClusterArn', { value: cluster.clusterArn });
    new cdk.CfnOutput(this, 'DbSecretArn', { value: cluster.secret!.secretArn });
    new cdk.CfnOutput(this, 'DbName', { value: 'nhs_slm' });
    new cdk.CfnOutput(this, 'OpenSearchEndpoint', { value: domain.domainEndpoint });
  }
}
