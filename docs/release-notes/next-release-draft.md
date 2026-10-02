# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.120.0** (2026-10-01).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

- **Windows viewer self-update lab check (#7681).** Nothing in CI runs a real
  Windows update. After the release assets publish, launch an installed older
  viewer (v0.118/v0.119/v0.120) on the Windows lab VM with no session open,
  accept "Restart & update", and confirm the installed `breeze-viewer.exe`
  reports the new version. On failure, the banner names the stage and
  `%LOCALAPPDATA%\com.breeze.viewer\logs\updater.log` has the error.

## Self-Hosting / Upgrade Notes (fold into the release body)

- **Breeze Viewer auto-update on Windows works again (#7681).** The Windows
  update bundle (`breeze-viewer-windows.msi.zip`) was Deflate-compressed in
  every release from at least v0.110.0 to v0.120.0, and the viewer's updater
  cannot unpack Deflate. Windows viewers downloaded and verified each update,
  then showed "Update X failed — will retry on next launch" and stayed on their
  installed version. The bundle is now stored uncompressed. The fix is in the
  bundle, not the viewer, so installed Windows viewers pick up this release on
  their next launch without a manual reinstall. A failed viewer update now names the stage (downloading,
  verifying its signature, unpacking the installer, installing) and shows the
  updater's error, and every viewer logs update activity to `updater.log` in
  its log directory: `%LOCALAPPDATA%\com.breeze.viewer\logs\` (Windows),
  `~/Library/Logs/com.breeze.viewer/` (macOS),
  `~/.local/share/com.breeze.viewer/logs/` (Linux).
