#!/usr/bin/env bash
# One-time setup of a fresh local wt-stack for the Wisp harness. Idempotent: every
# step checks the database first and skips what is already done.
#
#   1. the seeded admin becomes a platform admin
#   2. the partner gets a manual `wisp` entitlement (system scope)
#   3. the admin enrols TOTP through the API; the secret stays in .state/
#   4. a virtual WebAuthn approver device is registered through Profile > Approval security
#   5. a partner-wide Triage agent in shadow mode with the recommended operations
#   6. the test world (sh/world.sh): built BEFORE the grant so Wisp's first look sees it
#   7. Wisp is turned on for All organizations (grant step-up with a TOTP code), budget $5/day
#
# setup.sh [step...]   run only the named steps (admin entitlement totp approver triage world grant)
set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

BUDGET_CENTS="${WISP_EVAL_BUDGET_CENTS:-500}"
STEPS="${*:-admin entitlement totp approver triage world grant}"

# A .state/ from an earlier stack (same project name, fresh database) holds a TOTP
# secret and passkeys the new database never saw: discard them.
fingerprint="$(q "select id || '@' || created_at from users where email = $(sqlq "$EMAIL")")"
[ -n "$fingerprint" ] || { echo "admin $EMAIL not found; is the stack seeded?" >&2; exit 1; }
if [ -f "$STATE/stack-id" ] && [ "$(cat "$STATE/stack-id")" != "$fingerprint" ]; then
  say "state belongs to an earlier stack; clearing .state/ (keeping the agentsim binary)"
  find "$STATE" -mindepth 1 -maxdepth 1 ! -name sim -exec rm -rf {} +
  find "$STATE/sim" -mindepth 1 ! -name agentsim -exec rm -f {} + 2>/dev/null || true
fi
(umask 077; printf '%s' "$fingerprint" > "$STATE/stack-id")

PARTNER="$(partner_id)"
[ -n "$PARTNER" ] || { echo "admin has no partner membership" >&2; exit 1; }
USER_ID="$(q "select id from users where email = $(sqlq "$EMAIL")")"

step_admin() {
  if [ "$(q "select is_platform_admin from users where id = '$USER_ID'")" = "t" ]; then say "admin: already platform admin"; return; fi
  q "update users set is_platform_admin = true where id = '$USER_ID'" >/dev/null
  say "admin: promoted to platform admin"
}

step_entitlement() {
  local have
  have="$(qsys "select count(*) from partner_entitlements where partner_id = '$PARTNER' and feature_key = 'wisp' and state = 'enabled' and revoked_at is null")"
  if [ "$have" != "0" ]; then say "entitlement: wisp already enabled"; return; fi
  qsys "insert into partner_entitlements (partner_id, feature_key, state, source, reason)
        values ('$PARTNER', 'wisp', 'enabled', 'manual', 'wisp-eval harness (local stack)')
        on conflict (partner_id, feature_key, source) do update set state = 'enabled', revoked_at = null, updated_at = now()" >/dev/null
  say "entitlement: wisp enabled (manual); the API caches entitlements for up to 60 s"
}

step_totp() {
  local enabled res sec code tok
  enabled="$(q "select mfa_enabled from users where id = '$USER_ID'")"
  if [ "$enabled" = "t" ] && [ -s "$STATE/totp-$WUSER.txt" ]; then say "totp: already enrolled"; return; fi
  if [ "$enabled" = "t" ]; then
    echo "totp: the admin has MFA but .state/ has no secret for it; recreate the stack (pnpm wt-stack down && up)" >&2
    exit 1
  fi
  rm -f "$TOKF"
  login
  res="$(api POST /auth/mfa/setup "$(jq -n --arg p "$PASSWORD" '{currentPassword:$p}')")"
  sec="$(printf '%s' "$res" | jq -r '.secret // empty')"
  [ -n "$sec" ] || { echo "totp: setup returned no secret" >&2; exit 1; }
  (umask 077; printf '%s' "$sec" > "$STATE/totp-$WUSER.txt")
  code="$(totp)"
  res="$(api POST /auth/mfa/enable "$(jq -n --arg c "$code" --arg p "$PASSWORD" '{code:$c,currentPassword:$p}')")"
  tok="$(printf '%s' "$res" | jq -r '.tokens.accessToken // empty')"
  [ -n "$tok" ] || { echo "totp: enable failed" >&2; exit 1; }
  (umask 077; printf '%s' "$tok" > "$TOKF")
  rm -f "$STATE/state-$WUSER.json"   # browser sessions were revoked by the MFA epoch bump
  say "totp: enrolled (secret in .state/totp-$WUSER.txt)"
}

step_approver() {
  local n
  n="$(q "select count(*) from authenticator_devices where user_id = '$USER_ID' and disabled_at is null and label = 'wisp-eval virtual authenticator'")"
  if [ "$n" != "0" ] && [ -s "$STATE/passkeys-$WUSER.json" ]; then say "approver: virtual device already registered"; return; fi
  if [ "$n" != "0" ]; then
    # Registered, but the private key is gone with an old .state/: retire that row and register again.
    q "update authenticator_devices set disabled_at = now(), disabled_reason = 'wisp-eval: passkey file lost' where user_id = '$USER_ID' and disabled_at is null and label = 'wisp-eval virtual authenticator'" >/dev/null
  fi
  (cd "$HARNESS" && STRICT=1 STEPS='[
      ["fill","[data-testid=\"approver-device-label-input\"]","wisp-eval virtual authenticator"],
      ["totp","[data-testid=\"approver-stepup-code\"]"],
      ["click","[data-testid=\"approver-device-register\"]"],
      ["wait","5000"]
    ]' SEL='[data-testid="approver-devices-section"]' node look.cjs /settings/profile setup-approver 600 >/dev/null)
  n="$(q "select count(*) from authenticator_devices where user_id = '$USER_ID' and disabled_at is null and label = 'wisp-eval virtual authenticator'")"
  [ "$n" != "0" ] && [ -s "$STATE/passkeys-$WUSER.json" ] || { echo "approver: registration did not land (see .state/shots/setup-approver.png)" >&2; exit 1; }
  say "approver: virtual device registered"
}

step_triage() {
  local have catalog ops body
  have="$(q "select count(*) from ai_agents where partner_id = '$PARTNER' and org_id is null and kind = 'triage'")"
  if [ "$have" != "0" ]; then say "triage: partner-wide triage agent exists"; return; fi
  catalog="$(api GET /ai/agents/tool-catalog)"
  ops="$(printf '%s' "$catalog" | jq -c '(.data // .).presets.triage // []')"
  [ "$ops" != "[]" ] || { echo "triage: no recommended operations in the tool catalog" >&2; exit 1; }
  body="$(jq -n --argjson ops "$ops" '{kind:"triage", name:"Triage", ownerScope:"partner", mode:"shadow", enabled:true, toolAllowlist:$ops}')"
  api POST /ai/agents "$body" >/dev/null
  say "triage: created partner-wide, shadow, enabled, operations $ops"
}

step_grant() {
  local gid preview hash code step tz
  gid="$(q "select id from wisp_grants where partner_id = '$PARTNER' and org_id is null and status = 'active' and expires_at > now() order by created_at desc limit 1")"
  if [ -z "$gid" ]; then
    preview="$(api GET /wisp/grants/preview)"
    hash="$(printf '%s' "$preview" | jq -r '.ceilingHash // .data.ceilingHash // empty')"
    [ -n "$hash" ] || { echo "grant: preview returned no ceilingHash" >&2; exit 1; }
    code="$(totp)"
    step="$(api POST /auth/mfa/step-up "$(jq -n --arg c "$code" --arg p "$PARTNER" --arg h "$hash" '{method:"totp",code:$c,operation:"wisp_grant",resource:{partnerId:$p,orgId:null,requestedCeilingHash:$h}}')" | jq -r '.stepUpGrantId // empty')"
    [ -n "$step" ] || { echo "grant: step-up failed" >&2; exit 1; }
    tz="${TZ_NAME:-$(readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##')}"
    api POST /wisp/grants "$(jq -n --arg s "$step" --arg tz "${tz:-UTC}" '{orgId:null,stepUpGrantId:$s,browserTimezone:$tz}')" >/dev/null
    api GET /wisp/thread >/dev/null
    gid="$(q "select id from wisp_grants where partner_id = '$PARTNER' and org_id is null and status = 'active' order by created_at desc limit 1")"
    say "grant: Wisp on for All organizations ($gid)"
  else
    say "grant: active all-organizations grant exists ($gid)"
  fi
  if [ "$(q "select budget_cents_per_day from wisp_grants where id = '$gid'")" != "$BUDGET_CENTS" ]; then
    api PATCH "/wisp/grants/$gid/settings" "$(jq -n --argjson b "$BUDGET_CENTS" '{budgetCentsPerDay:$b}')" >/dev/null
    say "grant: budget set to $BUDGET_CENTS cents/day"
  fi
}

for s in $STEPS; do
  case "$s" in
    admin|entitlement|totp|approver|triage|grant) "step_$s" ;;
    world) bash "$HARNESS/sh/world.sh" ;;
    *) echo "unknown step $s" >&2; exit 2 ;;
  esac
done
say "setup done"
