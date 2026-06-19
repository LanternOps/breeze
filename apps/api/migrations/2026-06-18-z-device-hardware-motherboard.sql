ALTER TABLE device_hardware
  ADD COLUMN IF NOT EXISTS motherboard_manufacturer varchar(255),
  ADD COLUMN IF NOT EXISTS motherboard_product varchar(255),
  ADD COLUMN IF NOT EXISTS motherboard_version varchar(255);
