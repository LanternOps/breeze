-- Enforce that C2C backup configs can only reference storage configs in the same org.
CREATE OR REPLACE FUNCTION enforce_c2c_storage_config_org_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.storage_config_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM backup_configs
    WHERE id = NEW.storage_config_id
      AND org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'c2c backup config storage_config_id must reference a backup config in the same org'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS c2c_storage_config_org_guard ON c2c_backup_configs;
CREATE TRIGGER c2c_storage_config_org_guard
  BEFORE INSERT OR UPDATE OF org_id, storage_config_id ON c2c_backup_configs
  FOR EACH ROW
  EXECUTE FUNCTION enforce_c2c_storage_config_org_match();
