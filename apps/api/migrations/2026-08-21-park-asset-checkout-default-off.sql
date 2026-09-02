-- Park asset checkout: default the portal flag OFF.
--
-- The checkout/check-in API (POST /portal/assets/:id/checkout|checkin), the
-- asset_checkouts table, and the admin toggle all exist, but the customer
-- portal never received the Check Out / Check In UI. With the flag on, an org
-- gets an "Equipment" page that mirrors Devices and cannot borrow anything.
-- Keep the feature, stop shipping the half of it that makes a promise the
-- other half can't keep.
--
-- Idempotent: SET DEFAULT is a no-op on re-run; the backfill reports its row
-- count per the migration cleanup rule so the change leaves a trail.

ALTER TABLE portal_branding
  ALTER COLUMN enable_asset_checkout SET DEFAULT false;

DO $$
DECLARE
  n integer;
BEGIN
  -- Existing rows were created under the old DEFAULT true; no org could have
  -- meaningfully used the feature (no portal UI), so parking them is safe.
  UPDATE portal_branding SET enable_asset_checkout = false WHERE enable_asset_checkout = true;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'parked asset checkout on % portal_branding rows', n;
  END IF;
END $$;
