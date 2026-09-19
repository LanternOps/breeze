-- Bind refresh-token families to the signed mobile installation that created
-- them. A lost-phone block can then durably revoke only that installation's
-- families while ordinary web and other-device sessions remain active.
--
-- Nullable is intentional: web/SSO families have no mobile binding, and
-- historical family rows cannot be safely inferred. Live bearer and refresh
-- checks against mobile_devices cover those historical signed-token families.

ALTER TABLE refresh_token_families
  ADD COLUMN IF NOT EXISTS mobile_device_id varchar(255);

CREATE INDEX IF NOT EXISTS refresh_token_families_user_mobile_device_idx
  ON refresh_token_families (user_id, mobile_device_id)
  WHERE mobile_device_id IS NOT NULL;
