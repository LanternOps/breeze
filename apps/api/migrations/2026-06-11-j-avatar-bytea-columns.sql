-- Move user avatars from the filesystem (/data/avatars/<id>.<ext>) into the
-- database as a bytea blob on the users row. The old filesystem path depended
-- on a writable `api_data` volume owned by the API's runtime uid; when that
-- volume was root-owned the upload failed with EACCES and a 500. Storing the
-- bytes in Postgres removes the volume dependency and works across replicas.
--
-- Columns:
--   avatar_data       bytea  — the raw image bytes (PNG/JPEG/WebP, ≤ 5 MB).
--                              Postgres TOASTs values over ~2 KB out-of-line,
--                              so the base row stays lean; size-only reads use
--                              octet_length() to avoid pulling the blob.
--   avatar_mime       text   — sniffed content type (image/png|jpeg|webp).
--   avatar_updated_at timestamptz — bump on each write; powers a cheap weak
--                              ETag (size + mtime) without hashing the bytes.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data bytea;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;

-- A pre-existing INTERNAL avatar_url ('/api/v1/users/<id>/avatar') pointed at
-- a filesystem-backed avatar that this migration does NOT carry over (the
-- bytes stay on the old volume). Clear those now-dangling URLs so the UI falls
-- back to initials instead of a broken image; affected users simply re-upload.
-- External URLs (the pre-upload era let users set arbitrary avatar URLs) are
-- deliberately left alone — they still resolve.
-- Always log the count (even 0) so the run leaves a forensic trail.
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE users
     SET avatar_url = NULL
   WHERE avatar_url LIKE '/api/v1/users/%/avatar'
     AND avatar_data IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'cleared % dangling filesystem avatar_url(s) during bytea migration', n;
END $$;
