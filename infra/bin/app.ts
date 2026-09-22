import * as cdk from 'aws-cdk-lib';
import { SlmDataStack } from '../lib/slm-data-stack';

const app = new cdk.App();
new SlmDataStack(app, 'SlmDataStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'eu-west-2' },
});
