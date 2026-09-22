#!/usr/bin/env bash
# Build the app and deploy it to AWS Amplify.
#
# The Amplify app has no GitHub connection, so `git push` does NOT deploy: this script is
# what ships a change. Builds run from ~/nhs-app because the project lives on an iCloud-synced
# Desktop, where node tooling crawls.
#
# Usage: ./deploy.sh
set -euo pipefail

APP_ID=d252ri3fd8l5el
BRANCH=main
REGION=eu-west-2
SRC="$(cd "$(dirname "$0")" && pwd)"
WORK="$HOME/nhs-app"
export AWS_PROFILE="${AWS_PROFILE:-AdministratorAccess-489597129436}"

[ -f "$WORK/.env.local" ] || { echo "error: $WORK/.env.local missing — the build needs VITE_API_URL and VITE_API_KEY"; exit 1; }

echo "==> syncing source to $WORK"
rsync -a --delete "$SRC/src/" "$WORK/src/"

echo "==> typecheck"
(cd "$WORK" && npx tsc --noEmit -p tsconfig.json)

echo "==> build"
(cd "$WORK" && npm run build >/dev/null)

echo "==> packaging"
ZIP=$(mktemp -d)/site.zip
(cd "$WORK/dist" && zip -qr "$ZIP" .)

echo "==> deploying to Amplify"
OUT=$(aws amplify create-deployment --app-id "$APP_ID" --branch-name "$BRANCH" --region "$REGION" --output json)
JOB=$(echo "$OUT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["jobId"])')
URL=$(echo "$OUT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["zipUploadUrl"])')
curl -sf -X PUT -H "Content-Type: application/zip" --upload-file "$ZIP" "$URL" >/dev/null
aws amplify start-deployment --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB" --region "$REGION" >/dev/null

until STATUS=$(aws amplify get-job --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB" \
  --region "$REGION" --query 'job.summary.status' --output text 2>/dev/null); \
  [ "$STATUS" = "SUCCEED" ] || [ "$STATUS" = "FAILED" ] || [ "$STATUS" = "CANCELLED" ]; do sleep 5; done

echo "==> job $JOB: $STATUS"
[ "$STATUS" = "SUCCEED" ] || exit 1
echo "==> live: https://$BRANCH.$APP_ID.amplifyapp.com"
