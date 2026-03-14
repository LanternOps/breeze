BEGIN;

-- ai_sessions.type
ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'general';

-- software_catalog.org_id
ALTER TABLE software_catalog ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);

-- software_versions new columns
ALTER TABLE software_versions ADD COLUMN IF NOT EXISTS s3_key text;
ALTER TABLE software_versions ADD COLUMN IF NOT EXISTS file_type varchar(20);
ALTER TABLE software_versions ADD COLUMN IF NOT EXISTS original_file_name varchar(500);

-- users.preferences
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences jsonb;

COMMIT;
