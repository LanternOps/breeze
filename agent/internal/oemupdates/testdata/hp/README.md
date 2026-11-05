# HP lane test data

**Everything under `doc-derived/` is written from HP's published documents, not captured from a machine.** It exists so the HP lane can be built and tested before the HP lab wave (W14, #11079). Every HP gate stays closed until then. The sources are the HP Image Assistant user guide (936944-005), HP's HPIA download page and CMSL's published command help.

What is not confirmed, and what W14 must capture on real hardware:

**HPIA (legs H2, H3, H5)**

- **The report.** The guide says `/ReportFolder` receives `.HTML` and `.XML` output, and gives neither a file name nor a schema. `report-*.xml` assume `HPIA/Recommendations/<group>/Recommendation/Solution/Softpaq/{Id,Name,Version}`. The lane reads any `*.xml` there, with a soft parser: on an install run, an unreadable report gives no items and `errorCode=report_unavailable`, while the outcome still comes from the exit code.
- **A per-update result.** No document shows one. `<Status>` in `report-download-only.xml` is an assumption, and the lane treats a recommendation without one as installed only when the whole run was clean. `/ResultFilePath` ("Readme" in the report folder) may be the real source.
- **`/SPList` with `/Action:Install`. Check this first: it decides whether a blocked update can install.** The guide documents `/SPList` as "Downloads the SoftPaqs listed", with `/Action:Extract`, and says nothing about `/Action:Install`. The lane passes the list on the install run and writes raw numbers, one per line, as the guide says. If an install ignores the list, a blocked update installs. The lane can name that only if the report carries a per-update result (`blocked_update_installed`).
- **Exit 3011.** HP's page: "Returned when attempting to install non-SSM compliant SoftPaqs", taking precedence over 3010 and 3020. So it can hide a needed reboot; the lane maps it to `partial` and asks for the reboot.
- **Exit 0 on `/Action:Install`.** The guide's "There is no error" is the only text; the lane maps it to `success`.
- **Installer switches.** `/s /e /f <dir>` are the SoftPaq extract switches as commonly scripted. The guide does not list them. Whether extracting over an older copy leaves stale files is also unknown.
- **Signer name and hosts** in `allowlist.json`: `HP Inc.`, and `hpia.hpcloud.hp.com` per HP's download page. `ftp.hp.com` and `ftp.ext.hp.com` serve SoftPaqs; which of them redirect to which is not captured.
- **Whether `/Category` holds.** `FlashesOutsideFilter` stays true until a driver-only run is shown to write no firmware.
- **Firmware and BitLocker.** HP's guide for HPIA does not mention suspending BitLocker, and this lane does nothing about it for the `firmware` category. **The guide also warns of complete data loss from a TPM firmware update on an encrypted drive**, says the TPM utility refuses when BitLocker is on, and that it needs physical presence. Whether HPIA's `Firmware` category can deliver that is the first question for H5. If BitLocker is unaddressed, `firmware` stays closed.
- **HP Sure Admin.** HP's page says that with Enhanced BIOS Authentication Mode on, the BIOS cannot be updated through HPIA in Download Only mode; the spec reads it as updates becoming download-only. What the report says in that case is unknown, and `<Status>Downloaded</Status>` is a placeholder.
- **Argument quoting.** Go quotes the whole of `/ReportFolder:C:\a b\c` when a path has a space. The data directory normally has none, so this has not been exercised.
- **Licence (H1).** HP says a valid licence from HP is required. Nothing fetches HPIA until the owner decides and a manifest pin exists.
