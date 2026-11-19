# Sourced by the harness scripts. Local wt-stack only; never point this at a real deployment.
# shellcheck shell=bash
HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$HARNESS/../.." && pwd)"
STATE="$HARNESS/.state"
mkdir -p "$STATE" && chmod 700 "$STATE"
DESC="${BREEZE_STACK_DESCRIPTOR:-$ROOT/.breeze-stack.json}"
[ -f "$DESC" ] || { echo "no stack descriptor at $DESC (run pnpm wt-stack up, or set BREEZE_STACK_DESCRIPTOR)" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

API="$(jq -r .apiUrl "$DESC")/v1"
BASE="$(jq -r .baseUrl "$DESC")"
PG="$(jq -r .pgContainer "$DESC")"
PROJECT="$(jq -r .project "$DESC")"
# shellcheck disable=SC2034  # used by sim.sh
APIC="${PROJECT}-api-1"
EMAIL="$(jq -r .admin.email "$DESC")"
PASSWORD="$(jq -r .admin.password "$DESC")"
JAR="$STATE/cookies.txt"
TOKF="$STATE/token"
WUSER="${WUSER:-admin}"
export BREEZE_STACK_DESCRIPTOR="$DESC"

case "$BASE" in
  http://localhost:*|http://127.0.0.1:*) ;;
  *) echo "refusing to run against $BASE: the harness only drives a local stack" >&2; exit 1 ;;
esac

# q SQL — run SQL as the superuser (bypasses RLS), unaligned, ' | ' separated.
q() { docker exec -i "$PG" psql -U breeze -d breeze -At -F ' | ' -v ON_ERROR_STOP=1 -c "$1"; }
# qsys SQL — same, inside one transaction that elects system scope (for statements that rely on it).
qsys() { printf "BEGIN;\nSELECT set_config('breeze.scope','system',true) AS scope_set \\gset\n%s;\nCOMMIT;\n" "$1" | docker exec -i "$PG" psql -U breeze -d breeze -At -F ' | ' -v ON_ERROR_STOP=1 -q; }
# sqlq 'text' — quote a value as an SQL string literal.
sqlq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

totp() { (cd "$HARNESS" && node -e "require('./lib.cjs').freshCode().then((c) => process.stdout.write(c))"); }

# login — password (+ TOTP when enrolled); caches the bearer in .state/token.
login() {
  local body res tmp code tok
  body="$(jq -n --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p}')"
  res="$(curl -sS -b "$JAR" -c "$JAR" -X POST "$API/auth/login" -H 'content-type: application/json' -d "$body")"
  # A first login can answer 428 with a client-binding cookie; the retry carries it.
  if [ -z "$(printf '%s' "$res" | jq -r '.tokens.accessToken // .tempToken // empty' 2>/dev/null)" ]; then
    res="$(curl -sS -b "$JAR" -c "$JAR" -X POST "$API/auth/login" -H 'content-type: application/json' -d "$body")"
  fi
  if [ "$(printf '%s' "$res" | jq -r '.mfaRequired // false')" = "true" ]; then
    tmp="$(printf '%s' "$res" | jq -r .tempToken)"
    code="$(totp)"
    res="$(curl -sS -b "$JAR" -c "$JAR" -X POST "$API/auth/mfa/verify" -H 'content-type: application/json' \
      -d "$(jq -n --arg c "$code" --arg t "$tmp" '{code:$c,tempToken:$t,method:"totp"}')")"
  fi
  tok="$(printf '%s' "$res" | jq -r '.tokens.accessToken // empty')"
  [ -n "$tok" ] || { echo "login failed: $(printf '%s' "$res" | jq -c '{error,message,code}' 2>/dev/null || printf '%s' "$res" | cut -c1-200)" >&2; return 1; }
  (umask 077; printf '%s' "$tok" > "$TOKF")
  chmod 600 "$JAR" 2>/dev/null || true
}

# api METHOD PATH [JSON] — prints the body; non-2xx returns 1 with the status on stderr.
api() {
  [ -s "$TOKF" ] || login
  local m="$1" p="$2" d="${3:-}" code body
  body="$(mktemp "$STATE/.body.XXXXXX")"
  code="$(curl -sS -b "$JAR" -c "$JAR" -o "$body" -w '%{http_code}' -X "$m" "$API$p" -H "authorization: Bearer $(cat "$TOKF")" -H 'content-type: application/json' ${d:+-d "$d"})"
  if [ "$code" = "401" ]; then
    login
    code="$(curl -sS -b "$JAR" -c "$JAR" -o "$body" -w '%{http_code}' -X "$m" "$API$p" -H "authorization: Bearer $(cat "$TOKF")" -H 'content-type: application/json' ${d:+-d "$d"})"
  fi
  cat "$body"
  rm -f "$body"
  [ "${code:0:1}" = "2" ] || { echo " [HTTP $code $m $p]" >&2; return 1; }
}

# Common lookups by name (the world is built idempotently by name, never by id).
org_id() { q "select id from organizations where name = $(sqlq "$1") and deleted_at is null order by created_at limit 1"; }
site_id() { q "select s.id from sites s join organizations o on o.id = s.org_id where o.name = $(sqlq "$1") and s.name = $(sqlq "$2") order by s.created_at limit 1"; }
device_id() { q "select id from devices where display_name = $(sqlq "$1") order by enrolled_at desc nulls last limit 1"; }
partner_id() { q "select pu.partner_id from partner_users pu join users u on u.id = pu.user_id where u.email = $(sqlq "$EMAIL") limit 1"; }
say() { printf '%s\n' "$*" >&2; }
