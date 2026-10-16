-- software_policies.managed_by_link_id (#6960, wave #8735).
--
-- A software policy generated from a `security_agents` config-policy feature
-- link points back at that link. The column is the managed-row discriminator:
-- the API refuses direct edits/deletes of such rows (409) and the resolver
-- gives them their own resolution dimension.
--
-- ON DELETE CASCADE, not SET NULL: deleting the config policy (or the link)
-- removes the generated policy. SET NULL would erase the only discriminator and
-- leave an ordinary armed policy behind. Removing the generated policy never
-- uninstalls anything: compliance rows cascade and
-- software_deployments.software_policy_id is already ON DELETE SET NULL.
--
-- No rows are written. The scope election is a guard for future edits.
-- Idempotent: ADD COLUMN / CREATE INDEX IF NOT EXISTS.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE software_policies
  ADD COLUMN IF NOT EXISTS managed_by_link_id uuid
  REFERENCES config_policy_feature_links(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS software_policies_managed_by_link_idx
  ON software_policies (managed_by_link_id)
  WHERE managed_by_link_id IS NOT NULL;
