-- Move user avatars from the filesystem (/data/avatars/<id>.<ext>) into the
-- database as a bytea blob on the users row. The old filesystem path depended
-- on a writable `api_data` volume owned by the API's runtime uid; when that
-- volume was root-owned the upload failed with EACCES and a 500. Storing the
-- bytes in Postgres removes the volume dependency and works across replicas.
--
-- Columns:
--   avatar_data       bytea  — the raw image bytes (PNG/JPEG/WebP, ≤ 5 MB).
--                              Postgres TOASTs this out-of-line so the base row
--                              stays lean and SELECTs that don't reference it
--                              don't pay for it.
--   avatar_mime       text   — sniffed content type (image/png|jpeg|webp).
--   avatar_updated_at timestamptz — bump on each write; powers a cheap weak
--                              ETag (size + mtime) without hashing the bytes.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data bytea;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;

-- Any pre-existing avatar_url pointed at a filesystem-backed avatar that this
-- migration does NOT carry over (the bytes stay on the old volume and are not
-- migrated). Clear the now-dangling URLs so the UI falls back to initials
-- instead of rendering a broken image / 404; affected users simply re-upload.
-- Report the count so the operation is visible in the Postgres log.
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE users
     SET avatar_url = NULL
   WHERE avatar_url IS NOT NULL
     AND avatar_data IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'cleared % dangling filesystem avatar_url(s) during bytea migration', n;
  END IF;
END $$;
