-- Backfill software_versions.file_type for versions created from a download URL.
--
-- The JSON create-version route (POST /software/catalog/:id/versions) never
-- accepted or derived a file_type -- only the upload paths did, from the
-- uploaded filename. services/softwareDeployment.ts therefore dispatched
-- `fileType: 'exe'` / `fileName: 'package.exe'` for every URL-created version,
-- and the agent's EXE branch execs the downloaded file DIRECTLY
-- (exec.CommandContext(ctx, localPath, ...) in software_install.go). For an MSI
-- that fails at CreateProcess with ERROR_BAD_EXE_FORMAT ("This version of %1 is
-- not compatible with the version of Windows you're running") and the
-- operator's `msiexec /i "{file}" ...` command is discarded unused.
--
-- Only rows where the URL carries an unambiguous installer extension are
-- touched. A URL with no usable extension keeps file_type NULL and the
-- historical 'exe' dispatch behavior -- guessing there would trade one wrong
-- answer for another.
--
-- silent_install_args is deliberately NOT rewritten: with file_type corrected,
-- buildMSIExecArgs already defaults an empty args string to
-- `/i <path> /qn /norestart` and strips a leading `msiexec` token from a
-- supplied one. Editing an operator's stored install command is out of scope
-- for a data repair.

DO $$
DECLARE
  updated_count integer;
BEGIN
  WITH derived AS (
    SELECT
      id,
      lower(
        substring(
          -- Path portion only: a presigned or tokenized URL puts the signature
          -- in the query string, and `{{org.name}}`-style deploy-time tokens can
          -- appear anywhere in it.
          split_part(split_part(download_url, '#', 1), '?', 1)
          FROM '\.([A-Za-z]+)$'
        )
      ) AS ext
    FROM software_versions
    WHERE file_type IS NULL
      AND download_url IS NOT NULL
  )
  UPDATE software_versions sv
  SET file_type = derived.ext
  FROM derived
  WHERE sv.id = derived.id
    AND derived.ext IN ('msi', 'exe', 'dmg', 'deb', 'pkg');

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count > 0 THEN
    RAISE WARNING 'backfilled file_type on % url-created software_versions row(s)', updated_count;
  END IF;
END $$;
