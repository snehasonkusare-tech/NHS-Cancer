"""Load workbooks into S3, Aurora (Data API) and OpenSearch (Titan v2 embeddings).

Usage: python load_data.py --bucket B --cluster-arn A --secret-arn S --os-endpoint E [--region eu-west-2]
(values come from the CDK stack outputs)
"""
import argparse, json, re, boto3, openpyxl
from opensearchpy import OpenSearch, RequestsHttpConnection, AWSV4SignerAuth, helpers

ROOT = "../.."
PATIENT_XLSX = f"{ROOT}/nhs_slm_patient_records.xlsx"
KB_XLSX = f"{ROOT}/nhs_slm_knowledge_base.xlsx"
SKIP = {"Overview", "Data Dictionary", "Data Mapping", "User Journeys", "User Stories"}
INDEX = "nhs-ng12-kb"
DIM = 1024


def snake(s):
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_") or "col"


def rows(path, sheet):
    ws = openpyxl.load_workbook(path, read_only=True)[sheet]
    it = ws.iter_rows(values_only=True)
    header = [str(h) if h is not None else "" for h in next(it)]
    return header, [["" if c is None else str(c) for c in r] for r in it if any(c is not None for c in r)]


def sheets(path):
    return [s for s in openpyxl.load_workbook(path, read_only=True).sheetnames if s not in SKIP]


def load_aurora(a):
    rds = boto3.client("rds-data", region_name=a.region)
    base = dict(resourceArn=a.cluster_arn, secretArn=a.secret_arn, database="nhs_slm")
    for sheet in sheets(PATIENT_XLSX):
        header, data = rows(PATIENT_XLSX, sheet)
        table, cols, seen = snake(sheet), [], set()
        for h in header:
            c = snake(h)
            while c in seen:
                c += "_"
            seen.add(c); cols.append(c)
        rds.execute_statement(**base, sql=f'DROP TABLE IF EXISTS "{table}"')
        rds.execute_statement(**base, sql=f'CREATE TABLE "{table}" ({", ".join(f"{chr(34)}{c}{chr(34)} TEXT" for c in cols)})')
        sql = f'INSERT INTO "{table}" VALUES ({", ".join(f":p{i}" for i in range(len(cols)))})'
        for i in range(0, len(data), 100):
            rds.batch_execute_statement(**base, sql=sql, parameterSets=[
                [{"name": f"p{j}", "value": {"stringValue": v}} for j, v in enumerate(r)] for r in data[i:i + 100]])
        print(f"aurora: {table} <- {len(data)} rows")
    # patient lookups by ID (the first column of every patient-keyed table)
    rds.execute_statement(**base, sql='CREATE INDEX IF NOT EXISTS idx_test_patients_id ON "test_patients"("patient_id")')


def load_opensearch(a):
    bedrock = boto3.client("bedrock-runtime", region_name=a.region)
    host = a.os_endpoint.replace("https://", "")
    os_ = OpenSearch(hosts=[{"host": host, "port": 443}], http_auth=AWSV4SignerAuth(boto3.Session().get_credentials(), a.region, "es"),
                     use_ssl=True, connection_class=RequestsHttpConnection, timeout=60)

    def embed(text):
        r = bedrock.invoke_model(modelId="amazon.titan-embed-text-v2:0", body=json.dumps(
            {"inputText": text[:8000], "dimensions": DIM, "normalize": True}))
        return json.loads(r["body"].read())["embedding"]

    if os_.indices.exists(INDEX):
        os_.indices.delete(INDEX)
    os_.indices.create(INDEX, body={"settings": {"index": {"knn": True}}, "mappings": {"properties": {
        "text": {"type": "text"}, "sheet": {"type": "keyword"}, "row_id": {"type": "keyword"},
        "embedding": {"type": "knn_vector", "dimension": DIM,
                      "method": {"name": "hnsw", "engine": "faiss", "space_type": "l2"}}}}})

    def actions():
        for sheet in sheets(KB_XLSX):
            header, data = rows(KB_XLSX, sheet)
            for n, r in enumerate(data, 1):
                text = " | ".join(f"{h}: {v}" for h, v in zip(header, r) if v and v != "None")
                yield {"_index": INDEX, "_source": {"text": text, "sheet": sheet, "row_id": r[0] or str(n), "embedding": embed(text)}}

    ok, _ = helpers.bulk(os_, actions())
    print(f"opensearch: indexed {ok} chunks into {INDEX}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    for f in ("bucket", "cluster-arn", "secret-arn", "os-endpoint"):
        p.add_argument(f"--{f}", required=True)
    p.add_argument("--region", default="eu-west-2")
    a = p.parse_args()
    s3 = boto3.client("s3", region_name=a.region)
    for f in (PATIENT_XLSX, KB_XLSX):
        s3.upload_file(f, a.bucket, "raw/" + f.split("/")[-1])
    print("s3: uploaded source workbooks")
    load_aurora(a)
    load_opensearch(a)
