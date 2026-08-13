#!/usr/bin/env bash
# Install + enroll the NU Agent inside the test container.
#
#   docker compose exec linux-endpoint nu-enroll
#
# Reads NU_SERVER and NU_ENROLLMENT_KEY from the environment (compose passes
# them through from .env). The key is per-download and never stored in the repo.
set -euo pipefail

SERVER="${NU_SERVER:-https://rmm.nodesunlimited.com}"
KEY="${NU_ENROLLMENT_KEY:-}"

if [[ -z "$KEY" ]]; then
  echo "NU_ENROLLMENT_KEY is not set." >&2
  echo "Put it in testing/linux/.env, then: docker compose up -d --force-recreate" >&2
  exit 2
fi

echo "==> installing service"
nu-agent service install

echo "==> enrolling against $SERVER"
# --enrollment-secret is optional; only set it if the server requires one.
if [[ -n "${NU_ENROLLMENT_SECRET:-}" ]]; then
  nu-agent enroll "$KEY" --server "$SERVER" --enrollment-secret "$NU_ENROLLMENT_SECRET"
else
  nu-agent enroll "$KEY" --server "$SERVER"
fi

echo "==> starting service"
nu-agent service start || systemctl start nu-agent

sleep 3
systemctl --no-pager status nu-agent || true
echo
echo "logs:  journalctl -u nu-agent -f"
