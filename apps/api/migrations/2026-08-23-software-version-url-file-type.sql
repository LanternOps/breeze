-- Backfill software_versions.file_type for versions that never recorded one.
--
-- The JSON create-version route (POST /software/catalog/:id/versions) never
-- accepted or derived a file_type -- only the upload paths did, from the
-- uploaded filename. services/softwareDeployment.ts therefore dispatched
-- `fileType: 'exe'` / `fileName: 'package.exe'` for every URL-created version,
-- and the agent's Windows EXE branch execs the downloaded file DIRECTLY
-- (exec.CommandContext(ctx, localPath, parts...) in software_install.go). For an
-- MSI that fails at CreateProcess with ERROR_BAD_EXE_FORMAT ("This version of %1
-- is not compatible with the version of Windows you're running"). The operator's
-- `msiexec /i "{file}" ...` was not discarded but MISROUTED -- passed as argv to
-- the MSI itself. On macOS/Linux the same 'exe' fallback failed earlier still,
-- as `unsupported file type "exe" on <os>`, which is why dmg/deb/pkg rows are
-- in scope here too.
--
-- Derivation order is original_file_name FIRST, then download_url. This is not
-- arbitrary: the agent's validateInstallFileName rejects the command outright
-- unless the filename's extension equals '.' || file_type, and
-- softwareDeployment.ts sends original_file_name verbatim as the filename when
-- it is set. So for those rows the filename is the ONLY source that yields a
-- dispatchable pair -- deriving from the URL instead could stamp a file_type
-- that contradicts the filename and convert a working install into a hard
-- validation failure.
--
-- Only rows whose source carries an unambiguous installer extension are
-- touched. A row with no usable extension keeps file_type NULL and the
-- historical 'exe' dispatch behavior -- guessing there would trade one wrong
-- answer for another. Those rows are counted and reported below, because THAT
-- is the actionable number: they are the packages that will still fail their
-- next deploy.
--
-- silent_install_args is deliberately NOT rewritten: with file_type corrected,
-- buildMSIExecArgs already defaults an empty args string to
-- `/i <path> /qn /norestart`, strips a leading `msiexec` token from a supplied
-- one, and prepends `/i <path>` when the supplied args don't already reference
-- the file -- so stored bare switches like `/qn /norestart` keep working.
-- Editing an operator's stored install command is out of scope for a data repair.

DO $$
DECLARE
  updated_count integer;
  skipped_count integer;
BEGIN
  WITH derived AS (
    SELECT
      id,
      lower(
        coalesce(
          -- The filename the agent will validate against, when we have one.
          substring(original_file_name FROM '\.([A-Za-z0-9]+)$'),
          -- Path portion only: a presigned or tokenized URL puts the signature
          -- in the query string, and `{{org.name}}`-style deploy-time tokens can
          -- appear anywhere in it.
          substring(
            split_part(split_part(download_url, '#', 1), '?', 1)
            FROM '\.([A-Za-z0-9]+)$'
          )
        )
      ) AS ext
    FROM software_versions
    WHERE file_type IS NULL
      AND (download_url IS NOT NULL OR original_file_name IS NOT NULL)
  )
  UPDATE software_versions sv
  SET file_type = derived.ext
  FROM derived
  WHERE sv.id = derived.id
    AND derived.ext IN ('msi', 'exe', 'dmg', 'deb', 'pkg');

  GET DIAGNOSTICS updated_count = ROW_COUNT;

  -- Counted AFTER the update, so this is the residue: rows still unclassified.
  SELECT count(*) INTO skipped_count
  FROM software_versions
  WHERE file_type IS NULL
    AND (download_url IS NOT NULL OR original_file_name IS NOT NULL);

  -- Reported unconditionally, including zero. A suppressed zero cannot be
  -- distinguished from "the migration never ran", which is exactly the
  -- forensic question someone asks when a deploy fails after this ships.
  RAISE WARNING 'software_versions.file_type backfill: % row(s) classified, % row(s) still unclassified (these will dispatch as exe and fail for non-exe installers)',
    updated_count, skipped_count;
END $$;
