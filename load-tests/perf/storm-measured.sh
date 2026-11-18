#!/usr/bin/env bash
# load-tests/perf/storm-measured.sh — is a failed storm report a MEASURED gate miss?
#   storm-measured.sh <storm.json>
# storm.sh exits 3 whenever .storm.pass is false, and the simulator sets pass false
# not only when a gate missed but also when the harness broke: a fault step failed,
# fewer events ran than planned, an event was cut short, or a gate saw no data.
# The perf workflow keeps a storm red warn-only only when this says the run measured
# what it set out to (#11623); anything else is a harness failure and fails the job.
# Exit: 0 measured (every fault fired, every event ran its window, every failing gate
# has data), 1 not measured (reasons on stderr), 64 usage.
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: storm-measured.sh <storm.json>" >&2; exit 64; }
REPORT="$1"
[ -s "$REPORT" ] || { echo "storm-measured: no storm report at $REPORT" >&2; exit 1; }

# One line per reason the run did not measure. A failing gate with no value is
# "no data", except pool-recovery on an event whose pool WAS sampled: there the
# value is null because the pool never recovered inside the window, a real miss.
if ! reasons="$(jq -r '
  if (.storm | type) != "object" then "the report has no storm block" else
  .storm as $s | ($s.events // []) as $ev
  | (if ($s.stepsFailed // 1) != 0 then "\($s.stepsFailed // "unknown") fault step(s) failed" else empty end),
    (if ($s.eventsPlanned // 0) < 1 or ($ev | length) != $s.eventsPlanned
     then "\($ev | length) of \($s.eventsPlanned // 0) planned events ran" else empty end),
    ($ev[] | select(.truncated == true) | "event \(.name): cut short before its recovery window ended"),
    ($ev[] | select(((.heartbeat.storm.count // 0) + (.heartbeat.recovery.count // 0)) == 0)
      | "event \(.name): no heartbeats (agents never reached the API)"),
    (($s.gates // [])[] | select(.pass == false and .value == null) | . as $g
      | select(($g.gate == "pool-recovery"
                and any($ev[]; .name == $g.event and (.pool.okSamples // 0) > 0)) | not)
      | "gate \($g.gate) on \($g.event): no data")
  end' "$REPORT" 2>&1)"; then
  echo "storm-measured: unreadable storm report $REPORT: $reasons" >&2
  exit 1
fi

if [ -n "$reasons" ]; then
  echo "storm-measured: $REPORT is not a measured run:" >&2
  sed 's/^/  - /' <<<"$reasons" >&2
  exit 1
fi
echo "storm-measured: every fault fired and every failing gate has data; this is a measured gate miss" >&2
