#!/usr/bin/env bash
# Add one urgent, unassigned ticket that no assessment has seen yet (Northwind Dental).
# A scenario uses it to ask whether Wisp knows about a ticket that arrived after its
# last look. Tagged wispEval=scenario; reset.sh removes it. Idempotent by subject.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$HERE/common.sh"

NW="$(org_id 'Northwind Dental')"
[ -n "$NW" ] || { echo "plant-ticket.sh: the world is not built (run sh/world.sh)" >&2; exit 1; }
SUBJ='Server closet AC failed, file server overheating'
if [ "$(q "select count(*) from tickets where org_id = '$NW' and subject = $(sqlq "$SUBJ") and deleted_at is null")" = "0" ]; then
  api POST /tickets "$(jq -n --arg o "$NW" --arg s "$SUBJ" '{orgId:$o, subject:$s, priority:"urgent", ticketType:"incident",
    submitterName:"Dana Reyes", submitterEmail:"dana.reyes@northwind-dental.example",
    description:"The air conditioner in the server closet died overnight and the closet is very hot. The file server fans are at full speed. Please call me as soon as you can."}')" >/dev/null
fi
qsys "update tickets set custom_fields = coalesce(custom_fields, '{}'::jsonb) || '{\"wispEval\":\"scenario\"}'::jsonb
      where org_id = '$NW' and subject = $(sqlq "$SUBJ") and deleted_at is null" >/dev/null
say "planted ticket: $SUBJ"
