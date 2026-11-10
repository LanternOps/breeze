#!/usr/bin/env bash
# List issue-fixer candidates: every unassigned open issue that is not parked
# behind a decision, highest priority first and oldest first within a priority.
#
# The previous selection listed the 60 newest open issues, so anything older
# was never seen however long it waited (#9557 sat 19 days at rank 256 of 792).
#
# Usage: candidates.sh [bug|other|all]   (default: bug)
#   bug    every unassigned bug
#   other  everything else, first 60 after ranking
#   all    both, bugs first
# Output: #number <TAB> created <TAB> priority/effort labels <TAB> title
set -euo pipefail

REPO=LanternOps/breeze
# Labels that mean "not ready for a fixer": tracked elsewhere, or waiting on a person.
EXCLUDE='-label:epic -label:feature -label:wave -label:question -label:needs-decision -label:needs-info -label:pending-author -label:pending-verification -label:"blocked:design"'
RANK='def prio: [.labels[].name] as $l
  | if ($l|index("priority:p0")) then 0 elif ($l|index("priority-top3")) then 1
    elif ($l|index("priority:p1")) then 2 elif ($l|index("priority:p2")) then 3
    elif ($l|index("priority:p3")) then 5 else 4 end;
  sort_by([prio, .createdAt]) | .[]
  | "#\(.number)\t\(.createdAt[0:10])\t\([.labels[].name | select(test("^(priority|effort)"))] | join(","))\t\(.title)"'

candidates() {
  gh issue list --repo "$REPO" --state open --limit 1000 \
    --search "no:assignee $EXCLUDE $1" \
    --json number,title,labels,createdAt --jq "$RANK"
}

case "${1:-bug}" in
  bug) candidates 'label:bug' ;;
  other) candidates '-label:bug' | head -60 ;;
  all) candidates 'label:bug'; candidates '-label:bug' | head -60 ;;
  *) echo "usage: $0 [bug|other|all]" >&2; exit 2 ;;
esac
