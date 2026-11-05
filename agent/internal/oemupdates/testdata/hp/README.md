# HP lane test data

**Everything under `doc-derived/` is written from HP's published documents, not captured from a machine.** It exists so the HP lane can be built and tested before the HP lab wave (W14, #11079). Every HP gate stays closed until then. The sources are the HP Image Assistant user guide (936944-005), HP's HPIA download page and CMSL's published command help.

What is not confirmed, and what W14 must capture on real hardware:

**HPIA (legs H2, H3, H5)**

- **The report.** The guide says `/ReportFolder` receives `.HTML` and `.XML` output, and gives neither a file name nor a schema. `report-*.xml` assume `HPIA/Recommendations/<group>/Recommendation/Solution/Softpaq/{Id,Name,Version}`. The lane reads any `*.xml` there, with a soft parser: on an install run, an unreadable report gives no items and `errorCode=report_unavailable`, while the outcome still comes from the exit code.
- **A per-update result.** No document shows one. `<Status>` in `report-download-only.xml` is an assumption, and the lane treats a recommendation without one as installed only when the whole run was clean. `/ResultFilePath` ("Readme" in the report folder) may be the real source.
- **`/SPList` with `/Action:Install`. Check this first: it decides whether a blocked update can install.** The guide documents `/SPList` as "Downloads the SoftPaqs listed", with `/Action:Extract`, and says nothing about `/Action:Install`. The lane passes the list on the install run and writes raw numbers, one per line, as the guide says. If an install ignores the list, a blocked update installs. The lane can name that only if the report carries a per-update result (`blocked_update_installed`). With no readable report, a clean run with ids blocked reports `partial` and `blocked_updates_unconfirmed`. A blocked id that is not a SoftPaq number blocks nothing and is logged.
- **Exit 3011.** HP's page: "Returned when attempting to install non-SSM compliant SoftPaqs", taking precedence over 3010 and 3020. So it can hide a needed reboot; the lane maps it to `partial` and asks for the reboot.
- **Exit 0 on `/Action:Install`.** The guide's "There is no error" is the only text; the lane maps it to `success`.
- **Exit 3020 and a process with no exit code.** The lane asks for a reboot on both, whatever categories were asked for: 3020 means "one or more" failed, and a killed install may have been staging firmware. Check whether that is too eager once real runs are seen.
- **Other exit codes.** 4097 (bad parameters), 4098 (no internet) and 8199 (download failed) are in the guide and read as `failed` here. W14 may map them, for example 4098 to `retry_later`.
- **Installer switches.** `/s /e /f <dir>` are the SoftPaq extract switches as commonly scripted. The guide does not list them. Whether extracting over an older copy leaves stale files is also unknown.
- **Signer name and hosts** in `allowlist.json`: `HP Inc.`, and `hpia.hpcloud.hp.com` per HP's download page. `ftp.hp.com` and `ftp.ext.hp.com` serve SoftPaqs; which of them redirect to which is not captured.
- **Whether `/Category` holds.** `FlashesOutsideFilter` stays true until a driver-only run is shown to write no firmware.
- **Firmware and BitLocker.** HP's guide for HPIA does not mention suspending BitLocker, and this lane does nothing about it for the `firmware` category. **The guide also warns of complete data loss from a TPM firmware update on an encrypted drive**, says the TPM utility refuses when BitLocker is on, and that it needs physical presence. Whether HPIA's `Firmware` category can deliver that is the first question for H5. If BitLocker is unaddressed, `firmware` stays closed.
- **HP Sure Admin.** HP's page says that with Enhanced BIOS Authentication Mode on, the BIOS cannot be updated through HPIA in Download Only mode; the spec reads it as updates becoming download-only. What the report says in that case is unknown, and `<Status>Downloaded</Status>` is a placeholder.
- **Argument quoting.** Go quotes the whole of `/ReportFolder:C:\a b\c` when a path has a space. The data directory normally has none, so this has not been exercised.
- **Licence (H1).** HP says a valid licence from HP is required. Nothing fetches HPIA until the owner decides and a manifest pin exists.

**CMSL, the BIOS path (leg H4; `bios` stays closed until H4 passes and Decision 7 is settled)**

CMSL is hand-installed for the lab only. This lane detects it and never installs it; #5515 owns the install and its EULA consent.

- **Module layout.** The lane expects `Program Files\WindowsPowerShell\Modules\HPCMSL\<version>\HPCMSL.psd1` and `HP.Firmware\<version>\HP.Firmware.psm1`, and verifies both. Another layout refuses with `hp_cmsl_unverified`, and a bad signature with `hp_cmsl_signature_invalid` or `hp_cmsl_publisher_mismatch`. Only those two files are checked: other modules HPCMSL requires are found by name.
- **Signature checks on script files.** The publisher pin was written for executables. Whether it reads a signed `.psd1` and `.psm1` is not shown; a failure refuses the flash.
- **`Get-HPBIOSUpdates -Check`.** HP's how-to uses it to test whether an update is needed. The lane reads a true answer as "up to date". If that is backwards, `-Flash` runs on a current BIOS, and -Flash without `-Force` is expected not to reinstall it; confirm both.
- **`-Flash` errors.** The lane's script gives its own exit codes: 256 up to date, 3010 staged, 2 failed before the flash, 1 failed in it. Any other code, including PowerShell's own, is treated as possibly flashed, and a reboot is asked for. A `-Flash` run on a current BIOS, with nothing staged, would still read as staged.
- **Does `-Flash` reboot by itself?** Nothing here can stop it. The flash guard only holds Breeze's own power actions.
- **`-BitLocker suspend`.** The reboot count and whether protection returns after the reboot Breeze schedules. The W11 BitLocker guard does not cover this suspension, because CMSL makes it, so nothing resumes it if the reboot never comes.
- **HP Sure Admin.** CMSL's offline flash needs a password or payload, and v1 passes no BIOS password. The lane expects a refusal and reports `bios_flash_uncertain`; record what really happens.
- **Blocked ids.** `Get-HPBIOSUpdates` takes no list, so any blocked id skips BIOS with `bios_blocklist_unenforceable`, even one for a driver or another vendor. Decide in W14 whether the BIOS's SoftPaq number can be read first.
- **HPIA is still required.** The run's tool step checks HPIA before any category is read, so without HPIA a BIOS-only run reports `tool_unavailable`.
- **The CMSL answer is cached for 24 hours**, like every availability gate. After hand-installing it, restart the agent or wait.
