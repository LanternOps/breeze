#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${BREEZE_ENV_FILE:-${REPO_ROOT}/.env.prod}"
# Grafana is defined in the monitoring overlay (docker-compose.monitoring.yml),
# which pins container_name: breeze-grafana. We exec into it by container
# name rather than via `docker compose -f deploy/docker-compose.prod.yml -f
# docker-compose.monitoring.yml`: that combination is not a valid compose
# project — the monitoring overlay's postgres-exporter service depends on a
# `postgres` service that only exists in the root docker-compose.yml (dev),
# not in the managed-Postgres prod stack. See #4278.
GRAFANA_CONTAINER="${GRAFANA_CONTAINER:-breeze-grafana}"

if [[ $# -ge 1 ]]; then
  ENV_FILE="$1"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[verify] Environment file not found: ${ENV_FILE}" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "${ENV_FILE}"; set +a

echo "[verify] Checking local monitoring endpoints"
curl -fsS "http://127.0.0.1:${PROMETHEUS_PORT:-9090}/-/healthy" >/dev/null
curl -fsS "http://127.0.0.1:${GRAFANA_PORT:-3000}/api/health" >/dev/null
curl -fsS "http://127.0.0.1:${LOKI_PORT:-3100}/ready" >/dev/null

echo "[verify] Checking Prometheus query for Breeze API target"
query='up{job="breeze-api"}'
response="$(curl -fsS --get --data-urlencode "query=${query}" "http://127.0.0.1:${PROMETHEUS_PORT:-9090}/api/v1/query")"
if ! grep -q '"status":"success"' <<<"${response}"; then
  echo "[verify] Prometheus query failed" >&2
  exit 1
fi

echo "[verify] Checking Grafana datasource provisioning"
if ! docker exec "${GRAFANA_CONTAINER}" test -f /etc/grafana/provisioning/datasources/datasources.yml; then
  echo "[verify] Grafana datasource file missing (or container ${GRAFANA_CONTAINER} not running)" >&2
  exit 1
fi

echo "[verify] Monitoring baseline looks healthy"
