-- #9593: the system SKU the agent reads from SMBIOS (HP's product number).
ALTER TABLE device_hardware
  ADD COLUMN IF NOT EXISTS product_sku varchar(100);
