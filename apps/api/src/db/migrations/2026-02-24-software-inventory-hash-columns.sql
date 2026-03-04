-- Add file_hash and hash_algorithm columns to software_inventory
-- These columns were added to the Drizzle schema via manual migration

ALTER TABLE public.software_inventory
  ADD COLUMN IF NOT EXISTS file_hash character varying(128),
  ADD COLUMN IF NOT EXISTS hash_algorithm character varying(10);

CREATE INDEX IF NOT EXISTS software_inventory_name_vendor_idx
  ON public.software_inventory USING btree (name, vendor);
