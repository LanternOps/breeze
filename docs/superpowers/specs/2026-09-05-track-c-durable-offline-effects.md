# Track C durable offline effects

Status: design reviewed and implemented; independent final code review and verification recorded in the execution plan.
Tracking: #4060; existing draft PR #4007.

## Scope amendment and delivery contract

This amends Track C's original no-migration port. The successful device CAS must
commit durable pending work in the SAME PostgreSQL transaction. A BullMQ progress
write, queue retry or in-memory after-commit callback cannot establish this fact.
A new tenant-scoped outbox and its migration/ownership registrations are authorized
by the September 5 product implementation round.

The guarantee is one successful transition and one LOGICAL event identity per
observation/effect, with recoverable at-least-once publication attempts. Redis
Streams/pubsub and arbitrary local subscribers do not offer exactly-once physical
delivery. A crash after publish but before acknowledgement can repeat delivery
under the SAME event ID. Existing durable event-dispatch jobs/receipts deduplicate
that ID; existing best-effort local subscribers retain their existing delivery
behavior and can observe duplicate invocations. Their successful processing is
not guaranteed by this outbox.
Do not describe the source outbox as an exactly-once event bus. Explicit duplicate
mark jobs create no additional source effects or alert identities.

Alerts admitted by this transition have deterministic UUIDs derived from the
transition + rule identity. Alert insertion and its pending publication/cooldown/
correlation effects commit atomically. Retrying after insertion cannot create a
second alert even if the original was already resolved. Non-offline producers'
existing alert deduplication semantics are unchanged.

## Reconnect, time and ownership semantics

- A heartbeat/status/org change that beats the CAS produces neither transition nor
  effects. Timestamp equality and tenant/status guards stay in the database UPDATE.
- A later heartbeat does not erase a historical offline event. The immutable event
  payload describes the accepted observation and uses the original org/site route.
- Alert evaluation is CURRENT-state eligibility, not retroactive paging: immediately
  before alert admission, lock and recheck device org, offline status and exact
  observed heartbeat. A reconnect, different offline generation, terminal status or
  ownership move completes that pending alert task as obsolete without creating an
  alert. An alert admitted before a heartbeat can resolve through normal workflows.
- Rule plans are snapped once when the durable evaluation task expands. Each rule
  uses that plan; configuration-policy condition/maintenance evaluation occurs at
  processing time. Deleted rules are skipped. Redis cooldown/flapping READS happen
  before admission, never writes inside a transaction that may roll back.
- Source outbox ownership is historical and immutable. Rows retain the source org,
  immutable payload and original route if a device later moves. They never read
  destination-tenant content for publication. Pending alert work becomes obsolete
  on such a move. A device deletion or org erasure cancels pending effects via
  cascading FKs; already-issued external sends cannot be recalled by deletion and
  retain the documented late-send limit. Org merge leaves historical rows with the loser for erasure (the
  existing leave-for-erasure policy); it does not repoint historical event payloads.

## Persistence

New `offline_transition_effects` table, one row per durable unit of work:

- `id` UUID PK: stable effect identity derived from transition ID + kind + rule ID;
- `transition_id` text, `org_id` UUID FK organizations ON DELETE CASCADE,
  `device_id` UUID FK devices ON DELETE CASCADE;
- `kind`: offline-event, alert-plan, alert-rule, alert-event, alert-postprocess;
- `rule_id` nullable UUID and `cooldown_until` nullable timestamptz for indexed
  durable admission receipts (postprocess rows);
- `payload` JSONB: immutable typed source snapshot or planned rule/event data;
- `created_at`, `available_at`, `attempts`, `lease_token`, `lease_until`,
  `completed_at`, bounded `last_error` code (never raw payload/exception).

Forced RLS + all CRUD policies use breeze_has_org_access(org_id); writes additionally
require system scope because the outbox admits privileged background work, not
tenant-submitted commands. Tenant scoped reads remain available. INSERT verifies
that device belongs to org, including a normal-role cross-tenant forgery test.
Updates cannot alter ownership, identity or payload. Internal expansion inserts
same-source-org children only while current device ownership matches; late historical
publication needs no new tenant content. No hidden marker in customFields.

The winning CAS inserts offline-event and (non-ephemeral only) alert-plan rows before
commit. Any insert failure rolls back the status update. The outbox PK collapses
source duplicates. Alert-plan expands once into stable per-rule work and marks itself
complete in the same DB-only transaction. Individual rule admission locks its effect
row and device, validates the unexpired lease and current observation, inserts its
stable alert UUID and child effects, then completes the rule atomically.

Terminal rows are pruned in bounded batches after 14 days AND after their
`cooldown_until` has expired. A seven-day legacy cooldown with4x adaptive
multiplier therefore retains its receipt for at least28 days. Pending rows are NEVER
pruned or abandoned merely because attempts are exhausted. Existing deterministic
mark job cleanup remains; outbox recovery does not depend on the mark job existing.

## Processing and short transactions

Reuse the already-required offline worker/queue; add a periodic recover-effects job
(every five seconds) and per-effect jobs. The recovery scan selects due/expired work
independently of device status, in bounded pages (500 per pass), then uses addBulk
OUTSIDE its DB context. Deterministic BullMQ effect IDs deduplicate active jobs;
exhausted failures are removed so later sweeps can re-admit them.

Each effect execution claims its own 60-second lease with a random token via a
short guarded UPDATE, committing before any external work. Claiming a batch does
not start every row's lease while it waits behind other work. Every completion,
retry schedule, child admission and alert insert is fenced by the current token
and unexpired lease. Stale owners cannot acknowledge another owner's work.
Transient failures keep pending rows and set bounded exponential retry scheduling
(maximum delay 60 seconds). Failure reporting uses existing worker observability
and a bounded error code; no permanent dead-letter abandonment.

Network-bound processing has a deadline shorter than the lease. The deadline
rejects work without pretending cancellation of an already-issued Redis command;
late sends may still occur, under the stable logical ID. No database transaction
is held while awaiting Redis, queue publication, correlation or event handlers.
Database planning and per-rule condition evaluation have separate short contexts.

`mark-offline` admits work and returns after the CAS/outbox transaction; alerts are
asynchronous. Recovery does not require another heartbeat or an online device.
The five-second sweep gives recovery after an admission-process crash; best-effort
immediate enqueue of source and expanded child effects reduces normal latency but is not the durable admission boundary.

## Alert preparation and external consequences

Use a dedicated offline-effects evaluator with existing feature-config resolvers,
condition evaluator and interpolation helpers. Do not run existing createAlert or
policy evaluator unchanged inside a receipt transaction: they interleave Redis
writes and DB writes and can suppress a retry after rollback.

The planner preserves both legacy offline rules and configuration-policy rules.
For each planned rule, DB-only reads/condition evaluation run in explicit contexts;
Redis cooldown/flapping reads run with no held context. Admission rechecks current
device/ownership and existing open alerts, then inserts alert + pending effects
atomically. Terminal skipped/suppressed rule decisions are explicit.

Redis is a secondary cooldown/flapping signal, not the sole authority. In the
same device-locked alert admission transaction, query indexed committed postprocess
receipts for that device/rule: any cooldown_until > now suppresses admission even
when Redis delivery is stalled and the old alert has resolved. Persist cooldown_until
with the alert and receipt. Legacy adaptive multiplier is derived from the latest
committed receipt within one hour (double, cap4), combined with the maximum
next multiplier from a valid recent Redis adaptive state (existing resolveAlert
advances that state too); policy rules keep multiplier1.
Preserve accepted legacy override cooldowns0..10080 minutes (seven days), including
a4x adaptive window up to28 days. Terminal pruning requires both age>14days AND
cooldown_until expired; pending rows remain indefinitely. Malformed values outside
existing accepted bounds fail pending work rather than silently truncating them.

For flapping, committed trigger receipt timestamps in the last ten minutes plus
resolved_at timestamps of that device/rule's alerts provide a durable count; four
or more suppress admission. Existing Redis isFlapping remains an additional OR
signal for transitions from other producer paths. Do not add Redis and DB counts
(which would double-count the same events). An indexed device/rule/time query bounds
this read. Two-generation tests stall postprocess, resolve A, and prove B cannot
bypass cooldown; a separate alternating trigger/resolve test proves pending Redis
recording cannot bypass the four-transition flapping floor.

Flapping suppression itself admits a durable cooldown-only postprocess receipt
before completing the rule (matching existing setCooldown/markConfigPolicyRuleCooldown).
Its payload explicitly records `recordTrigger:false`, no alert or event is inserted,
and it is excluded from durable trigger counts. Cooldown-only receipt admission is
also device/lease fenced. Zero-minute legacy cooldown remains valid: no Redis
SETEX with zero TTL, but any relevant adaptive/flapping history is still recorded.

Postprocess uses original alert timestamp and a stable effect identity. Redis
cooldown writes do not extend a cooldown merely because an old effect retries;
never shorten a newer existing cooldown. Flapping recording is atomic/idempotent
for the original timestamp within its relevant window; old retries do not become
new transitions. Correlation enqueue remains at-least-once/idempotent at its
existing queue boundary. Alert event publication is a separate durable effect.
Configuration-policy rule failures are surfaced and retried, never swallowed as
successful completion of the whole transition.

## Event bus change

Add an optional caller-supplied stable `eventId` and occurred-at timestamp to
PublishOptions, validated before I/O. Default publishers retain random UUIDs and
current timestamps. Outbox event payloads and timestamps are immutable and every
retry supplies the same values. No global behavior change to default publishers.
Stable IDs must continue through streams, pubsub, durable dispatch and local handlers.

## Migration and tenancy integration

Reserve migration `2026-10-09-000800-offline-transition-effects.sql` (main max000600;
parallel MFA work reserves000700). New table, policies, constraints and indexes
are idempotent; no shipped migration edits. Register schema export, tenant-cascade,
tenant-export policy (payload excludedOpen; scalar fields classified), and org-merge
leave-for-erasure disposition. Add direct device cleanup through FK CASCADE.
Exclude the table from breeze_device_child_orgid_tables and the route
denormalized move list, preserving other historical-table exclusions. Check RLS
coverage, cross-tenant forged insert/update, ownership move, and erasure.

## Evidence and limits

Tests must prove rollback atomicity, crash after committed CAS, expiry/reclaim and
stale owner fencing, Redis failure, crash after successful event publication,
crash after alert insertion, reconnect before CAS and before alert admission,
no duplicate alert after resolution/retry, isolated tenant/ownership boundaries,
no external I/O while holding DB contexts, and bounded sweep/failure retention.

The 10,000-device under-30-second drain, pool/worker headroom and readiness fault
rehearsal remain exact-candidate measurements. Passing tests does not claim those
measurements, deployment, customer rollout or QA finding closure.
