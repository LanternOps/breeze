-- UniFi multi-key sync: per-key outcome on each run (#11808, W2 #12277).
--
-- key_results holds one entry per API key the run read:
-- { keyId, label, status, hostsSeen, sitesSeen, error }. It never holds a key or
-- its ciphertext, and errors are capped at 500 characters by the writer.
--
-- unifi_sync_runs is partner-axis (partner_id, no org_id), so it is not in the
-- org cascade, org-merge or export-policy lists and this column needs no
-- export-policy classification. Schema change only: no rows are written.

ALTER TABLE unifi_sync_runs ADD COLUMN IF NOT EXISTS key_results jsonb;
