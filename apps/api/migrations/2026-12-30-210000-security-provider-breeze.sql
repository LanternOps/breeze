-- #6263 W02: Breeze's own IOC scanner (YARA-X engine and the legacy
-- signature table) gets its own provider so security_threats rows from a
-- security_scan command stop inheriting the device's AV product name.
-- ADD VALUE IF NOT EXISTS is a no-op on re-apply. No row writes.
ALTER TYPE security_provider ADD VALUE IF NOT EXISTS 'breeze';
