-- One manually-uploaded product image per catalog item, reused across quotes.
-- Partner-axis RLS (shape 3) — partner_id is the isolation axis, mirroring
-- catalog_items. Stored as a bytea blob like quote_images. Idempotent.
CREATE TABLE IF NOT EXISTS catalog_item_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL REFERENCES partners(id),
  image_data bytea NOT NULL,
  mime varchar(64) NOT NULL,
  byte_size integer NOT NULL,
  sha256 char(64) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

-- One image per item (upload replaces).
CREATE UNIQUE INDEX IF NOT EXISTS catalog_item_images_item_uq ON catalog_item_images (catalog_item_id);
CREATE INDEX IF NOT EXISTS catalog_item_images_partner_idx ON catalog_item_images (partner_id);

ALTER TABLE catalog_item_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_item_images FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'catalog_item_images'
      AND policyname = 'catalog_item_images_partner_access'
  ) THEN
    CREATE POLICY catalog_item_images_partner_access ON catalog_item_images
      FOR ALL
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
