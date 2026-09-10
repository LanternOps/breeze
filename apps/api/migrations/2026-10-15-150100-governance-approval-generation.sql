-- Site-ceiling gate contract §3/§7G: in-flight job protection for org-wide
-- governance objects a queued job might act on with a stale (edited-in-
-- between) copy of the config.
--
-- THE PROBLEM. A webhook/software-policy/backup-config edit can race an
-- already-queued job that carries (or will reload) that same row: the
-- webhook delivery worker today receives the full decrypted WebhookConfig
-- inline in the job payload at enqueue time, so an edit made after enqueue
-- (e.g. disabling the webhook, or an unrestricted admin correcting a URL) is
-- invisible to a delivery already in flight. Software-policy and
-- backup-config workers already reload by id at dispatch time, but neither
-- can tell "this row changed since I was queued" from "this row is
-- unchanged" — an approval_generation counter, bumped on every governing
-- edit and snapshotted onto the job at enqueue/schedule time, gives them
-- that comparison.
--
-- THE FIX. `approval_generation integer not null default 1` on the three
-- tables whose workers need this comparison (webhooks, software_policies,
-- backup_configs). Existing rows get generation 1 and keep working
-- unchanged. PATCH/enable routes bump the column; workers compare the
-- job-carried generation against the freshly-reloaded row's generation and
-- drop/skip/fail-closed on mismatch instead of acting on stale config. See
-- routes/webhooks.ts, routes/softwarePolicies.ts, routes/backup/configs.ts
-- (write-side bump) and workers/webhookDelivery.ts,
-- jobs/softwareComplianceWorker.ts, jobs/softwareRemediationWorker.ts,
-- jobs/backupWorker.ts (read-side compare).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Re-applying is a no-op.

ALTER TABLE webhooks
  ADD COLUMN IF NOT EXISTS approval_generation integer NOT NULL DEFAULT 1;

ALTER TABLE software_policies
  ADD COLUMN IF NOT EXISTS approval_generation integer NOT NULL DEFAULT 1;

ALTER TABLE backup_configs
  ADD COLUMN IF NOT EXISTS approval_generation integer NOT NULL DEFAULT 1;
