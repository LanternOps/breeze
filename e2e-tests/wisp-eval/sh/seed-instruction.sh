#!/usr/bin/env bash
# seed-instruction.sh <deviceDisplayName> <text> [verb]
#
# Writes a KEPT standing instruction for the admin: the same ai_memory_blocks row the
# capture chip's "Keep" produces (block_type standing_instruction, status confirmed,
# effect deny, no condition, no end date), so the tool gate can enforce it. verb is one
# of reboot shutdown run_script patch_install any_change (default any_change).
#
# Seeding skips the model-driven capture step on purpose: scenarios that use this test
# the enforcement, not whether a chip appeared. reset.sh retracts it again.
set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

dev="${1:-}"; text="${2:-}"; verb="${3:-any_change}"
[ -n "$dev" ] && [ -n "$text" ] || { echo "usage: seed-instruction.sh <deviceDisplayName> <text> [verb]" >&2; exit 2; }
case "$verb" in reboot|shutdown|run_script|patch_install|any_change) ;; *) echo "bad verb $verb" >&2; exit 2 ;; esac
did="$(device_id "$dev")"
[ -n "$did" ] || { echo "no device named $dev" >&2; exit 1; }
partner="$(partner_id)"
uid="$(q "select id from users where email = $(sqlq "$EMAIL")")"
# standingInstructionClauseHash: sha256 of effect|verb|condition|until|text (NFKC, lower-case), first 16 hex.
hash="$(printf '%s' "deny|$verb|||$text" | tr '[:upper:]' '[:lower:]' | shasum -a 256 | cut -c1-16)"
subject="device:$did:$verb:$hash"
content="$(jq -cn --arg d "$did" --arg v "$verb" --arg t "$text" --arg l "$dev" \
  '{effect:"deny",verb:$v,deviceId:$d,condition:null,until:null,text:$t,targetLabels:[$l],sourceMessageId:null,captureId:null}')"

updated="$(qsys "with u as (update ai_memory_blocks set status = 'confirmed', updated_at = now()
                 where tenant_partner_id = '$partner' and owner_kind = 'user' and owner_user_id = '$uid'
                   and block_type = 'standing_instruction' and subject_key = $(sqlq "$subject") returning 1)
                 select count(*) from u")"
if [ "$updated" = "0" ]; then
  qsys "insert into ai_memory_blocks (tenant_partner_id, owner_kind, owner_user_id, block_type, subject_key, content, confidence, status)
        values ('$partner', 'user', '$uid', 'standing_instruction', $(sqlq "$subject"),
                jsonb_build_object('instructionId', gen_random_uuid()) || $(sqlq "$content")::jsonb, 'medium', 'confirmed')" >/dev/null
fi
echo "kept instruction on $dev ($verb): $text"
