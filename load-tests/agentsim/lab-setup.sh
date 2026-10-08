#!/usr/bin/env bash
# load-tests/agentsim/lab-setup.sh — print the env the simulator needs against
# THIS worktree's wt-stack:   eval "$(load-tests/agentsim/lab-setup.sh)"
# Creates one enrollment key (maxUsage AGENTSIM_KEY_MAX_USAGE, default 2500) on
# the seeded Default Organization / Default Site. Lab use only: it prints the
# enrollment secret and admin password for eval.
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
HERE="$REPO/load-tests/agentsim"
DESC="$REPO/.breeze-stack.json"
[ -f "$DESC" ] || { echo "lab-setup: no $DESC — run: AGENT_ENROLL_RATE_LIMIT=5000 pnpm wt-stack up" >&2; exit 1; }
for bin in jq curl docker; do command -v "$bin" >/dev/null || { echo "lab-setup: $bin is required" >&2; exit 1; }; done

PROJECT="$(jq -r .project "$DESC")"
BASE_URL="$(jq -r .baseUrl "$DESC")"
API_URL="$(jq -r .apiUrl "$DESC")"
PG="$(jq -r .pgContainer "$DESC")"
EMAIL="$(jq -r .admin.email "$DESC")"
PASSWORD="$(jq -r .admin.password "$DESC")"
MAX_USAGE="${AGENTSIM_KEY_MAX_USAGE:-2500}"

API_CONTAINER="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" \
  --filter label=com.docker.compose.service=api --format '{{.Names}}' | head -n1)"
[ -n "$API_CONTAINER" ] || { echo "lab-setup: no running api container for $PROJECT" >&2; exit 1; }

LIMIT="$(docker exec "$API_CONTAINER" printenv AGENT_ENROLL_RATE_LIMIT 2>/dev/null || true)"
if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [ "$LIMIT" -lt "$MAX_USAGE" ]; then
  echo "lab-setup: AGENT_ENROLL_RATE_LIMIT in $API_CONTAINER is '${LIMIT:-unset}' (default 10/min per IP)." >&2
  echo "lab-setup: re-up with:  AGENT_ENROLL_RATE_LIMIT=5000 pnpm wt-stack up" >&2
  exit 1
fi
SECRET="$(docker exec "$API_CONTAINER" printenv AGENT_ENROLLMENT_SECRET)"

read -r ORG_ID SITE_ID < <(docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -F " "' <<'SQL'
SELECT s.org_id, s.id FROM sites s JOIN organizations o ON o.id = s.org_id
WHERE o.name = 'Default Organization' AND s.name = 'Default Site' LIMIT 1;
SQL
)
[ -n "${SITE_ID:-}" ] || { echo "lab-setup: seeded Default Organization / Default Site not found" >&2; exit 1; }

TOKEN="$(curl -fsS -X POST "$API_URL/v1/auth/login" -H 'content-type: application/json' \
  -d "$(jq -n --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p}')" | jq -r '.tokens.accessToken // empty')"
[ -n "$TOKEN" ] || { echo "lab-setup: admin login returned no access token" >&2; exit 1; }

KEY="$(curl -fsS -X POST "$API_URL/v1/enrollment-keys" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "$(jq -n --arg o "$ORG_ID" --arg s "$SITE_ID" --argjson m "$MAX_USAGE" '{orgId:$o,siteId:$s,name:"agentsim",maxUsage:$m}')" \
  | jq -r '.key // empty')"
[ -n "$KEY" ] || { echo "lab-setup: enrollment-key create returned no key" >&2; exit 1; }

cat <<EOF
export AGENTSIM_SERVER='$BASE_URL'
export AGENTSIM_ENROLLMENT_KEY='$KEY'
export BREEZE_AGENT_ENROLLMENT_SECRET='$SECRET'
export AGENTSIM_ADMIN_EMAIL='$EMAIL'
export AGENTSIM_ADMIN_PASSWORD='$PASSWORD'
export AGENTSIM_STORE='$HERE/.state/tokens-$PROJECT.json'
EOF
