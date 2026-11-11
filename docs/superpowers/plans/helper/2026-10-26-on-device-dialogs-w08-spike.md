# W08 8A — Capture-feasibility spike: go / no-go finding

- **Feature:** #10190 (on-device dialogs). **Wave:** #10222 (W08). **Task:** 8.1 in `2026-10-26-on-device-dialogs.md`.
- **Read against:** `main` at `3f8cbafa0b` (2026-11-10). Every `file:line` below is from that commit.
- **Method:** desk spike. I read the agent capture and launch paths, the one real ETW fixture in the repo, the earlier PAM lab write-ups, and Microsoft documentation. **No Windows machine was used.** The lab leg is in §6.
- **Evidence labels:** **[verified]** = read in the code, the repo fixture, a repo lab record, or the Microsoft page cited. **[inferred]** = reasoned from verified facts, or from non-Microsoft public reverse engineering. **[not checked]** = no source; the lab leg must settle it.

## 1. Verdict

**No-go for 8B–8D as planned.** W07 stays the shipped behaviour (spec §3.4, last line).

The No-go rests mainly on the installer cases. Those are a property of dismissing UAC first, and the conclusion is inferred from documented Windows behaviour. The other basis is that two fields are not demonstrated anywhere in the capture path: the working directory and the requester's identity.

Result per field, with the same result expected in all four cells [inferred, §3]:

| Field | Result |
|---|---|
| 1. Arguments | Partial: captured, but with parser losses |
| 2. Working directory | Fail: no source found |
| 3. Requester SID | Proxy only |
| 4. Logon id | Proxy only, and not read today |
| 5. Environment | Not captured; possibly not needed |

The recommendation rests on three facts:

1. **No source for the working directory was found.** The one captured 15028 payload carries the target path (twice), the command line, and an empty, unidentified fourth string [verified, fixture]. No documented API returns the working directory of a process that does not exist yet. The elevated process is created by the Application Information service only *after* consent [verified, MS UAC architecture]. A relaunch therefore cannot be faithful for any command whose arguments are relative paths. A routine MSP example is `setup.exe /configure configuration.xml` run from the folder that holds both files. If L4 (§6) shows the fourth slot is the working directory, this fact falls.
2. **The requester's SID and logon session are not captured. The agent infers them from whichever session owns `consent.exe`.** The agent attributes the request to the newest `consent.exe` and looks up that session's user. When that fails it falls back to the console user [verified, code]. That gives the *session owner*, not the requesting process. The two differ for `runas /user:` inside a session [inferred]. The console fallback names the wrong user whenever the requester is not the console user, for example on RDS or with fast user switching [verified: fallback path; inferred: frequency].
3. **The installer cases are not expected to relaunch faithfully, whatever is captured.**
   - A bootstrapper that elevates a child and waits gets `ERROR_CANCELLED` from `ShellExecuteEx` when Breeze dismisses UAC [verified, MS doc: "the user canceled the request"]. It then unwinds, often deleting the child it extracted [inferred].
   - An MSI install asks the Application Information service for *authorization* [verified, MS "Using Windows Installer with UAC"], so there is no elevated child process to relaunch [inferred]. Re-running `msiexec` restarts the install and loses the choices made in its UI. As `~breeze_elev` it also moves any per-user install into the wrong profile [inferred]. At best that is "partly" relaunchable (§5).
   - This is a property of *dismissing first*, not of capture.

**Narrower W08?** Slicing by prompt kind or `PromptOnSecureDesktop` is not expected to yield a Go. Capture happens in the SYSTEM agent and does not depend on the desktop or on the prompt UI, so the failing fields should fail the same way in all four cells [inferred, §3; L1 checks it].

The only narrower cut that could become a Go is a different one: **dismiss first only for a top-level launch whose command line is self-contained.** That means the requester is the shell, nothing waits on the child, and no argument depends on the working directory. It needs two facts the lab may or may not supply:

- the requesting PID or SID (§6 L1 or L10);
- whether the fourth string slot is the working directory (§6 L4).

Even with both, installers, which we expect to be most PAM requests [inferred], stay on the W07 path. That is a scope cut for Todd to weigh, not a recommendation from this spike.

## 2. What the capture path actually has

**Source.** ETW real-time session `Breeze-LUA-Discovery` on Microsoft-Windows-LUA `{93c05d69-…}` (`etwlua/etwlua_windows.go:22,56`). Only event **15028** is consumed (`:35`, `:93`). The provider is enabled with no extended-data properties, so no SID or session id is requested in the event header (`:61`) [verified].

**Payload.** `decodeConsentRequest` (`etwlua_windows.go:161-198`) scans UserData for UTF-16 runs (`consent_payload.go:18-28`). It takes the first drive-rooted string as the target path and the first string that starts with `"` as the command line [verified]. The only real fixture is `consent_payload_test.go:14`, Windows 11 build 26200, `breeze-agent.exe version`. Decoded with `bytes.fromhex` and read as little-endian 64-bit fields; the review re-ran the decode independently:

| Offset | Value | Reading |
|---|---|---|
| `0x00` | 482 | total size [verified] |
| `0x38` | `M2ComW6KO020T+rMtxPDHQ.0` (ASCII) | correlation-vector-shaped string [inferred] |
| `0xC0`, `0xC8`, `0xF0` | `0xCEB077E078`, 1296, 39796 | **unidentified.** `0xC8` or `0xF0` might be the requesting PID, and `0xC0` looks like an address. Nothing confirms any of these [not checked] |
| `0xD0`, `0xD8` | offsets 248, 318 → `C:\breeze-pamtest\breeze-agent.exe` (×2) | target path [verified] |
| `0xE0` | offset 388 → `"C:\breeze-pamtest\breeze-agent.exe" version ` | command line, trailing space [verified] |
| `0xE8` | offset 480 → empty string | **fourth string slot, empty in this sample.** Might be the working directory or the "reason" text [not checked] |

No SID, logon id, working directory or environment string appears in this sample [verified, one sample]. Absence from one sample is not proof that the field never exists, hence L1/L4 in §6.

**Event fields the agent fills.** `SubjectUsername`, `SubjectSessionID`, `Consent`, `TargetExecutablePath`, `CommandLine`, `ObservedAt`, `TargetExecutableHash` (`etwlua_windows.go:177-187`). `PID` and `ParentImage` exist on `Event` (`etwlua.go:139-141`) but are **never set** [verified].

**Requester attribution** (`etwlua/requester_session.go:80-111`, `requester_session_windows.go:18-137`) [verified]:

- The agent enumerates `consent.exe` processes with Toolhelp. It keeps those whose image is `%windir%\System32\consent.exe`, whose session is interactive, and that started within the last 30 s, then picks the newest (`requester_session.go:34-63`).
- Session → user is `WTSQueryUserToken(session)` → `TokenUser` → `LookupAccount` → `DOMAIN\user` (`requester_session_windows.go:114-137`). The **SID is read and then discarded**; only the name survives. No logon id is read.
- `Consent{PID, CreatedAt}` is set only when exactly one `consent.exe` was eligible (`requester_session.go:98-100`).
- If no `consent.exe` matches, the request goes to the **console session's user** (`:105-108`, source `console_fallback`).

**Downstream** [verified]:

- `RunPamFlow` routes the dialog to `ev.SubjectSessionID` (`heartbeat/pam_flow.go:99-102`). The v1 local path carries `ev.CommandLine` (`:230`).
- The v2 launch drops it. `LaunchSuspendedV2` builds the command line from the path alone, `fmt.Sprintf("\"%s\"", request.TargetPath)` (`pamactuator/tokenlaunch_windows.go:183`), and `pamlifetime/job_windows.go:126-128` passes no command line.
- The session is the first *active* session whose bare username matches (`tokenlaunch_windows.go:389-413`, strict variant `session_resolve.go:46-54`).
- The launch runs as `~breeze_elev`, via `LogonUser` at `:925` and the linked token at `:940`. It uses `~breeze_elev`'s environment block (`:1000`) and a **nil working directory** (`:1038-1039`). The account is design decision D3 in `docs/superpowers/specs/pam/2026-07-03-pam-path-b-token-launch-actuator-design.md:52`.
- Dedupe key = `sha256(path) + ":" + user` (`etwlua.go:444-447`). A second request for the same executable with *different arguments* within 30 s is dropped before posting (`:342-349`).

## 3. The matrix

The four cells are consent prompt (split-token admin) and credential prompt (standard user, over the shoulder), each with `PromptOnSecureDesktop` = 1 and 0.

**Why the cells barely differ.** Everything in §2 runs in the SYSTEM agent in session 0. It reads an ETW event written by AppInfo. `docs/superpowers/plans/pam/2026-07-03-pam-path-b-vm-validation.md:73-75` states this as a design-time finding, not a lab measurement [inferred] and a system-wide Toolhelp snapshot [verified, code]. Neither touches a desktop. `PromptOnSecureDesktop` only changes which desktop `consent.exe` draws on: "If the secure desktop is enabled, all elevation requests go to the secure desktop … If the secure desktop isn't enabled, all elevation requests go to the interactive user's desktop" [verified, [MS UAC architecture](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/architecture)]. The prompt kind is chosen by `consent.exe` after AppInfo has decided to prompt, so the 15028 payload is not expected to differ by kind [inferred; L1 checks it]. The setting matters for *dismissal* (#10177 window classes, `pamactuator/dismiss_instance_windows.go:25-28`) and for *where W07 draws the first question*. It does not matter for capture.

Lab evidence per cell [verified, repo records]:

- **Consent prompt, setting unknown:** the fixture (Windows 11; neither the prompt kind nor the setting was recorded, and the consent kind is assumed from the comment "UAC consent" [inferred]).
- **Credential prompt, apparently setting 0:** the 2026-10-17 lab captured Notepad from a standard user on Server 2022 (`docs/testing/release-sweeps/2026-10-17-v0.123.0-lab-pass.md:106-111,132`). The record shows the prompt drawn on the normal desktop. The registry value itself was not recorded, so the setting is inferred from where the prompt appeared. The command-line content was not recorded there.
- **The other two cells:** no record [not checked].

| Field | All four cells | Source today | Reliability | Label |
|---|---|---|---|---|
| **1. Argument list** | Available | 15028 command-line string (`etwlua_windows.go:162,182`) | Raw string, quoting kept verbatim. **Parser losses** (`consent_payload.go`): a command line that does not start with `"` is dropped (`:20`); any code unit outside `0x20–0xD7FF` splits the string, so a tab, a non-BMP character or U+E000–U+FFFF truncates the arguments or even the path (`:58`); UNC targets are rejected entirely, so the event is dropped (`:32-38`, `etwlua_windows.go:163-166`). Same-exe, different-args requests within 30 s are deduped away (`etwlua.go:444-447`) | Content [verified, 1 sample]; whether AppInfo always quotes [not checked] |
| **2. Working directory** | **No source found** | None. Not in the sample payload. The fourth string slot (`0xE8`) is empty and unidentified | **Fails** unless L4 identifies the slot | [verified absent in 1 sample]; all four cells [inferred]; slot meaning [not checked] |
| **3. Requester SID** | **Proxy only** | SID of the user of the session that owns the newest `consent.exe` (`requester_session_windows.go:114-137`), currently discarded after name lookup. Console-user fallback when attribution fails (`requester_session.go:105-108`) | Right for "user elevates from their own desktop". **Wrong** for `runas /user:X` inside another user's session (the prompt is in A's session, the requester is X) [inferred]. **Wrong** when the console fallback fires and the requester is not the console user, e.g. on RDS or with fast user switching. With two prompts within 30 s, "newest" is a guess (`:98-100`). The order of 15028 and `consent.exe` start is unknown, so "newest" could be the previous prompt [not checked → L12] | Mechanism [verified]; the runas and fallback gaps [inferred] |
| **4. Logon session (LUID)** | **Proxy only, not read today** | Could be read from the same `WTSQueryUserToken` token via `TokenStatistics` / `TokenGroupsAndPrivileges` ("the authentication ID associated with the token") [verified, [MS TOKEN_INFORMATION_CLASS](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class)] | Same proxy limit as the SID: the *session's* logon, not the requesting process's. For a split-token admin, the filtered and elevated tokens are separate linked logon sessions, so the LUID depends on which token is read [inferred]. Good enough to *bind* a launch to "the logon that was live at capture" (refuse after log-off/log-on). Not proof of who asked | API [verified]; binding semantics [inferred] |
| **5. Environment** | **Not available, and arguably not needed** | Not in the payload. The relaunch uses `CreateEnvironmentBlock(~breeze_elev)` (`tokenlaunch_windows.go:1000`) | The elevated child UAC itself creates is a new process with the admin's full token [verified, MS UAC architecture]. Whether it inherits the caller's environment [not checked]. The expectation is that it does not [inferred]. If L11 confirms that, a fresh block for the *launch* account is what UAC does too, and the spec's "environment" clause may be droppable | [inferred] |

**What differs by kind** (identity of the launched process, not capture):

- **Consent prompt:** UAC would run the target as the requester's own elevated token, with their profile, HKCU and mapped drives [inferred]. The W08 relaunch runs it as `~breeze_elev` [verified, D3 and `tokenlaunch_windows.go:925`].
- **Credential prompt:** UAC runs it as whichever admin typed credentials [inferred], so `~breeze_elev` is the closer analogue.
- So identity can be faithful only for the credential-prompt kind. Arguments are the best case for both kinds.

## 4. Other Windows sources for the missing fields

| Candidate | Would give | Privilege / timing | Assessment |
|---|---|---|---|
| The pending elevated child (`NtQueryInformationProcess` → PEB) | — | — | **Does not exist at capture time.** AppInfo "helps start such apps by creating a new process … with an administrative user's full access token" after consent [verified, MS UAC architecture]. There is nothing to query until the prompt is answered, and W08 dismisses it first |
| The **requesting** process (the `ShellExecute` caller, e.g. `explorer.exe` or a bootstrapper) | Token → SID, `AuthenticationId` LUID, session. PEB → command line (documented member), working directory and environment (undocumented `Reserved2` members) [verified, [MS RTL_USER_PROCESS_PARAMETERS](https://learn.microsoft.com/en-us/windows/win32/api/winternl/ns-winternl-rtl_user_process_parameters)] | SYSTEM: `PROCESS_QUERY_LIMITED_INFORMATION` for the token. `PROCESS_VM_READ` for the PEB, which `NtQueryInformationProcess` warns is "internal … and subject to change" [verified, [MS](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntqueryinformationprocess)]. Must be read while the caller is alive, inside the prompt window | **Blocked on identifying the PID.** It is not in the parsed payload. A header integer may be it (`0xF0` in the fixture) [not checked → L1]. Even then, the caller's *current* directory is not necessarily the `lpDirectory` it passed to `ShellExecuteEx` [inferred] |
| `consent.exe` command line | Public reverse engineering says AppInfo starts `consent.exe` with its own PID plus the size and address of a parameter block in its memory [inferred, non-MS] | SYSTEM + reading AppInfo's svchost memory; undocumented layout | Likely the same block 15028 serialises. Nothing new expected, fragile to depend on [inferred → L9] |
| AppInfo RPC (`RAiLaunchAdminProcess`) | Public RE says the call carries `CurrentDirectory` and startup info [inferred, non-MS] | Would need hooking AppInfo or an RPC/ETW-RPC trace | Not a supportable production source [inferred] |
| ETW extended data `EVENT_ENABLE_PROPERTY_SID` / `_TS_ID` on the LUA session | SID / session of the *writing* thread | Same SYSTEM session; one-line change at `etwlua_windows.go:61` | Writer is AppInfo. Whether it impersonates the caller when it writes 15028 [not checked → L10] |
| `WTSQuerySessionInformation` / `LsaGetLogonSessionData` | Session → user / logon details | SYSTEM; `WTSQueryUserToken` needs LocalSystem + `SE_TCB_NAME` [verified, [MS](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsqueryusertoken)] | Describes the *session*, which is today's proxy. Does not identify the requester |

## 5. Installer cases

| Case | What capture gets | After Breeze dismisses UAC | Relaunchable faithfully? |
|---|---|---|---|
| **`msiexec /i <path>`** | [not checked] whether 15028 fires at all for the MSI path, and what it names: `msiexec.exe` with arguments, or the `.msi` | Windows Installer "can call to the Application Information Service (AIS) to request administrator authorization to elevate an installation" [verified, [MS Using Windows Installer with UAC](https://learn.microsoft.com/en-us/windows/win32/msi/using-windows-installer-with-uac)], so the elevated work runs in the installer service, not in a child AppInfo launches [inferred]. A cancel ends that install, probably with 1602 user-exit [not checked] | **Partly.** Re-running `msiexec /i "<path>" <props>` elevated restarts the install from scratch (the user re-walks the UI; UI-chosen properties are lost) [inferred]. As `~breeze_elev`, a per-user or `ALLUSERS=""` package installs into **`~breeze_elev`'s profile, not the user's** [inferred]. A relative `.msi` path needs the working directory, which is §3 field 2 |
| **Bootstrapper `ShellExecuteEx(runas)` + wait** (setup.exe, Burn bundles, Office ODT) | Child path and arguments, if the parser keeps them | The bootstrapper's `ShellExecuteEx` fails with `ERROR_CANCELLED`, "the user canceled the request" [verified, [MS ShellExecuteEx](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecuteexw)]. It gets no process handle and typically aborts or reports failure [inferred]. Many delete the payload they extracted to `%TEMP%` on exit [inferred], so the captured target is gone or replaced. Hash pinning (`pinAndVerifyTokenLaunchTarget`, `tokenlaunch_windows.go:286`) would then fail the launch, which is correct but means it never runs [inferred]. Burn-style elevated companions take a pipe name and the parent PID on their command line and connect back [inferred, WiX public source]; with the parent gone they fail | **No.** Dismiss-first breaks the parent/child contract whatever is captured |
| **Arguments with spaces / quotes** | Verbatim if the command line starts with `"` and contains only `0x20–0xD7FF` | — | **Yes for the common case**, after fixing the parser losses in §3 field 1 and passing the string through instead of `:183` |
| **Relative paths that depend on cwd** | Argument text only | — | **No.** The working directory is not captured (§3 field 2). The relaunch's working directory is nil today (`:1039`) |

## 6. Lab leg (orchestrator / Todd)

Run on **Windows 11** (client) and **Server 2022** (RDS host, `helper_lifecycle_mode: always-on`, per #8996). Use one split-token admin account, one standard user, and a second standard user for the RDS and fast-user-switching legs.

Tooling:

- **probe.exe:** a tiny console app that, when it starts, writes its `GetCommandLineW`, `GetCurrentDirectoryW`, full environment, token user SID, `TokenStatistics.AuthenticationId`, session id and parent PID to a file.
- **ETW dump:** temporarily log the raw 15028 UserData as hex, as the fixture was captured. The hook point is the callback at `etwlua_windows.go:105-106`. Do this on a lab build only, never on a shipped one.

| # | Experiment | Answers |
|---|---|---|
| L1 | Each of the 4 cells (admin / standard user × `PromptOnSecureDesktop` 1 / 0): from `C:\lab\cwd-a`, run `Start-Process -Verb RunAs C:\lab\probe.exe -ArgumentList '"a b" c\"d rel\x.txt' -WorkingDirectory C:\lab\cwd-b`. Dump the 15028 hex. Approve the real prompt. Diff the payload against probe.exe's own report. Also record the PID of the calling PowerShell | Does the payload differ by kind or desktop? Is any header integer the caller PID or a LUID? Is the command line verbatim? |
| L2 | L1 with a launcher that calls `ShellExecuteEx` with an **unquoted** relative `lpFile=probe.exe` and parameters containing a tab and a non-BMP character | Does AppInfo always quote? Confirms or refutes the parser losses (§3 field 1) |
| L3 | Elevate a target on a UNC share (`\\host\share\probe.exe`) | Confirms the event is dropped today |
| L4 | Repeat L1 varying only `-WorkingDirectory` (`cwd-b` / `cwd-c` / omitted). Diff the payload slot at `0xE8` | **Is the fourth slot the working directory?** If yes, field 2 flips to available and §1's narrower cut becomes testable |
| L5 | Standard user, setting 1: `msiexec /i C:\lab\permachine.msi /l*v C:\lab\m.log` and a per-user `ALLUSERS=""` package. Dump 15028. Dismiss UAC, then record the msiexec exit code and log. Then token-launch the captured command as `~breeze_elev` and check where HKCU, Start-menu and ARP entries land | MSI capture shape, cancel code, per-user misplacement |
| L6 | A WiX Burn bundle and a minimal `ShellExecuteEx(runas)` + `WaitForSingleObject` harness. Dismiss UAC, then record `GetLastError` (expect 1223), whether the parent exits, and whether the extracted child still exists. Relaunch the captured child command line | Bootstrapper relaunchability |
| L7 | Admin A signed in; in A's session run `runas /user:B cmd`, then elevate from that `cmd`. Compare the attributed user with B | SID proxy failure for in-session `runas` |
| L8 | Server 2022 RDS: same account in two sessions, and two different users. Elevate from the second session. Record `SubjectSessionID`, attribution source (`consent_process` / `console_fallback`) and the session `LaunchSuspendedV2` resolves. Repeat with fast user switching on Windows 11 | Requester binding today; how often the console fallback fires |
| L9 | While a prompt is open (setting 1), read `consent.exe`'s command line as SYSTEM | Does it carry AppInfo PID / size / address? (§4) |
| L10 | Enable the LUA provider with `EVENT_ENABLE_PROPERTY_SID` and `EVENT_ENABLE_PROPERTY_TS_ID` on a lab build and log the extended data for 15028 | Is the writer's SID the requester's (impersonated) or AppInfo's? |
| L11 | For L1's approved run, compare probe.exe's environment with the caller's (set `FOO=1` in the calling shell first) | Does UAC itself carry the caller's environment? Settles the spec's "environment" clause |
| L12 | With a timestamped trace, record the ETW 15028 receive time and the creation time of the matching `consent.exe`. Raise two prompts within 30 s from two sessions | Event/process ordering. Can "newest `consent.exe`" attribute a request to the previous or another prompt? |

**What would change the verdict:** L4 showing the working directory *and* L1 or L10 yielding the requester PID or SID. With both, field 2 and fields 3–4 can be made reliable, and the narrower cut in §1 is worth a Gate. L5 and L6 are expected to confirm the installer conclusion, not reverse it. Reversing it would need the common bootstrappers to survive `ERROR_CANCELLED` and leave their child in place, and an MSI relaunch to land per-user state in the requester's profile.

## 7. Not sourced

- What the 15028 header integers and the fourth string slot mean.
- Whether AppInfo always quotes the command line.
- Whether 15028 fires on the MSI authorization path, and what it carries there.
- The MSI cancel exit code.
- The environment an elevated child inherits under UAC.
- Whether ETW extended-data SID reflects the caller.
- The ordering of event 15028 relative to `consent.exe` creation, and ETW real-time buffer loss under load.
- Which `PromptOnSecureDesktop` value was in force for the one fixture.
- `RAiLaunchAdminProcess` parameters and the `consent.exe` command-line format. Both come only from non-Microsoft reverse engineering, so they are [inferred].
- Bootstrapper behaviour on `ERROR_CANCELLED` beyond the documented error code. This is vendor-specific.
