#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
source venv/bin/activate

SECRET=$(security find-generic-password -s "BUGRADAR_API_SECRET" -w)
DUE=$(curl -s --max-time 30 "https://bug-radar.shubhamvishnu.workers.dev/api/pipeline/connections" \
  -H "Authorization: Bearer $SECRET" | python3 -c "
import json, sys
for c in json.load(sys.stdin):
    if c.get('due'):
        print(c['id'], c.get('sync_max_sessions', 8))
")

if [ -z "$DUE" ]; then
  echo "$(date): nothing due, skipping."
  exit 0
fi

while read -r id sessions; do
  echo "=== connection $id (sessions=$sessions): $(date) ==="
  python3 bug_radar.py --connection-id "$id" --sessions "$sessions" || echo "WARNING: connection $id failed"
done <<< "$DUE"
