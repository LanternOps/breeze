# Dell Command Update test data

**Everything under `doc-derived/` is written from Dell's published documentation, not captured from a machine.** It exists so the Dell lane can be built and tested before the Dell lab wave (W10, #11075).

What is not confirmed, and what W10 must capture on real hardware:

- **The `-outputLog` format.** `apply-success.txt` assumes one result line per update, `<ID>: <title> - <type> - <version> -- <result>`. The real format is unknown. The lane's parser is deliberately soft: a log it cannot read gives no items and `errorCode=report_unavailable`, while the outcome still comes from the exit code.
- **Whether `-report` takes a file or a folder**, and the report schema. The lane does not pass `-report` in W02.
- **Whether `-reboot=disable` with `-autoSuspendBitLocker=enable` still installs BIOS updates**, how long protection stays suspended, and that it comes back after the reboot (spec §4.5).
- **Dock updates.** Dell documents that dock firmware ignores `-updateType` and `-updateDeviceCategory`. Whether docks honour `-localblockedswb` is not confirmed, so a blocked dock update may still install.
- **`-updateDeviceCategory`.** The policy's four categories map to `-updateType` only, and nothing in v1 sets a device category, so the lane does not pass it.
- **Installer arguments.** DCU's installer is run with `/s /l=<log>` and the .NET Desktop Runtime with `/install /quiet /norestart /log <log>`. Both are documented switches, not observed ones.
- **Signer names and download hosts** in `allowlist.json`.
- **Schedule takeover (W06).** `settings-export.xml` is a guess at what `/configure -exportSettings=<folder>` writes: nested elements with a `Name` attribute, the leaves being settings. The takeover assumes only that shape, finds the one `.xml` file the export wrote, ignores `*ModifiedTime`/`*TimeSaved` timestamps, and learns what `/configure -scheduleManual -updatesNotification=disable` changed by comparing an export before and after. W10 must confirm:
  - the export's file name and schema, and that two exports with no change in between differ only in timestamps;
  - that `/configure -importSettings=<file>` accepts a file built from an export with some settings replaced, and what its exit codes are;
  - what a policy-locked install (settings controlled by Dell Command | Configure or ADMX) does on `/configure`: a no-op read back as `policy_locked`, or an exit code;
  - that a device already set to a manual schedule with notifications off reads as `policy_locked` on its first takeover (nothing changed, so nothing is owned). This is the expected answer, not a bug: Breeze then owns nothing and a release restores nothing.

W10 replaces these files with scrubbed captures (no hostnames, serials, usernames, service tags or customer data) and a W10 task deletes `doc-derived/`.
