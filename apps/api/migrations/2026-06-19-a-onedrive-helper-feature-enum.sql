-- Add the onedrive_helper feature type to the config_feature_type enum.
-- ADD VALUE IF NOT EXISTS is transaction-safe in PG12+ as long as the value
-- isn't *used* in the same transaction (it isn't here).
ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'onedrive_helper';
