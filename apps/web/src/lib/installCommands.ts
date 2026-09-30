export interface InstallCommandOptions {
  /** Breeze API origin, e.g. https://eu.2breeze.app */
  apiUrl: string;
  /** Enrollment token from the Add Device / setup flow */
  token: string;
  /** Optional org enrollment secret */
  enrollmentSecret?: string;
}

export interface InstallCommands {
  windows: string;
  macos: string;
  linux: string;
}

/**
 * Builds the copy-paste agent install commands shown in the Add Device modal
 * and the setup wizard.
 *
 * macOS/Linux route through the server-generated install.sh, which pre-flights
 * connectivity to the server (distinguishing "unreachable" from "intercepted
 * by a captive portal/router"), verifies the download, and surfaces enrollment
 * failures — instead of letting `installer`/`bash` die with a cryptic OS error
 * (see PR #1271 for the original field report). The one-liner itself only
 * trusts the fetched file after a shebang check, so an intercepting device
 * serving HTML is reported as a connectivity problem rather than executed.
 */
export function buildInstallCommands(opts: InstallCommandOptions): InstallCommands {
  const apiUrl = opts.apiUrl.replace(/\/+$/, '');
  const { token, enrollmentSecret } = opts;

  // The connectivity message is scoped to the fetch + shebang check only —
  // once install.sh runs it reports its own failures precisely, and appending
  // a "could not reach" hint after e.g. an enrollment error would mislead.
  const unixSecretFlag = enrollmentSecret ? ` --enrollment-secret "${enrollmentSecret}"` : '';
  const unixCmd =
    `f="$(mktemp)" && ` +
    `{ curl -fsSL --connect-timeout 10 -o "$f" "${apiUrl}/api/v1/agents/install.sh" && head -n1 "$f" | grep -q '^#!' || ` +
    `{ echo "[ERROR] Could not fetch the Breeze installer from ${apiUrl} — verify this machine has network access to your Breeze server." >&2; false; }; } && ` +
    `sudo bash "$f" --server "${apiUrl}" --token "${token}"${unixSecretFlag}`;

  // Windows downloads through the server's own route, never a hard-coded
  // GitHub URL: that route is what serves BYO / self-hosted signed binaries
  // (BINARY_SOURCE=local, or a custom BINARY_GITHUB_REPOSITORY) and what
  // install.sh already uses for macOS/Linux. In github mode the server 302s
  // to the release asset it is pinned to, which Invoke-WebRequest follows
  // exactly as it did for GitHub's own latest/download redirect (#4441).
  //
  // The MZ-magic check is the Windows analog of the unix shebang check: a
  // captive portal's 200 HTML saved as breeze-agent.exe would otherwise stop
  // the chain with PowerShell's raw "not a valid application" exception
  // (which never sets $LASTEXITCODE — the process fails to start). The
  // $LASTEXITCODE throws cover agent steps that DO run but fail, since
  // native exe exit codes do not trip $ErrorActionPreference.
  const winSecretFlag = enrollmentSecret ? ` --enrollment-secret "${enrollmentSecret}"` : '';
  const winThrow = (step: string) => `if($LASTEXITCODE){throw "Breeze: ${step} failed (exit code $LASTEXITCODE)"}`;
  // Go 1.22+ (the agent's pinned toolchain, agent/go.mod) cannot run below
  // Windows 10 / Server 2016 (#4608) -- check the OS floor before spending a
  // download on a box that can never run the agent. Same floor as the MSI's
  // LaunchCondition in agent/installer/breeze.wxs, which reads the registry
  // (CurrentMajorVersionNumber) because Windows Installer's own VersionNT is
  // shimmed to 603 on every Windows 10+ box. powershell.exe is manifested for
  // Windows 10, so OSVersion.Version reports the real major version here:
  // Windows 10 and every Server release from 2016 onward report 10, so
  // `.Major -lt 10` is exactly that same floor.
  const winOsFloorCheck =
    `$osv=[System.Environment]::OSVersion.Version; ` +
    `if($osv.Major -lt 10)` +
    `{throw "Breeze: Windows 10 or Windows Server 2016 or later is required (detected $($osv.Major).$($osv.Minor))"}`;
  // Download into a private temp directory, never the shell's working
  // directory. An elevated PowerShell starts in C:\Windows\system32, so a
  // relative -OutFile lands the agent INSIDE System32; `service install` then
  // copies it from there into Program Files and Defender's ASR rule "Block use
  // of copied or impersonated system tools" (C0033C00-...) denies every open
  // of that copy, even to SYSTEM - the service is registered but can never
  // start (#5898).
  //
  // A fixed, predictable directory name (the old 'breeze-install') can be
  // pre-created by any other local principal before this script runs, which
  // silently adopts their directory (and its permissions) when combined with
  // -Force. Use a fresh, randomly named directory instead, created without
  // -Force so a pre-existing directory at that path is a hard error, then
  // strip inherited permissions and grant only the invoking principal and
  // SYSTEM (well-known SID, so this also holds when the one-liner itself is
  // already running as SYSTEM, e.g. under PsExec -s or an MDM/RMM runner).
  const winStageDir =
    `$guid=[guid]::NewGuid().ToString('N'); ` +
    `$d=Join-Path $env:TEMP "breeze-install-$guid"; ` +
    `New-Item -ItemType Directory -Path $d -ErrorAction Stop | Out-Null; ` +
    `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ` +
    `icacls $d /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*\${sid}:(OI)(CI)F" | Out-Null; ` +
    `if($LASTEXITCODE -ne 0){throw "Breeze: could not set restrictive permissions on the staging directory $d"}; ` +
    `$exe=Join-Path $d 'breeze-agent.exe'`;
  const winMzCheck =
    `$b=[IO.File]::ReadAllBytes($exe); ` +
    `if($b.Length -lt 2 -or $b[0] -ne 0x4D -or $b[1] -ne 0x5A)` +
    `{throw "Breeze: downloaded file is not a Windows executable - a captive portal or web filter may be intercepting this network"}`;
  // The MZ check only rules out a middlebox's HTML response; it does not
  // prove the bytes are the genuine, untampered agent build. Mirror
  // install.sh's own Linux verification: fetch the release's SHA-256 from
  // the same trusted server (the public, unauthenticated agent-versions
  // metadata endpoint) and require an exact match before the binary is ever
  // invoked — a mismatched or unfetchable checksum fails closed. Self-hosted
  // builds are not guaranteed to carry an Authenticode signature, so
  // Get-AuthenticodeSignature is checked as a second, best-effort control:
  // when a signature IS present it must be valid, but an unsigned binary is
  // not rejected on that basis alone — the checksum check above is the
  // control that always applies.
  const winChecksumUrl =
    `${apiUrl}/api/v1/agent-versions/latest?platform=windows&arch=amd64&component=agent`;
  const winFetchChecksum =
    `try{$meta=Invoke-RestMethod -Uri "${winChecksumUrl}" -UseBasicParsing}` +
    `catch{throw "Breeze: could not fetch release integrity metadata from ${apiUrl} - refusing to install without a trusted checksum"}; ` +
    `$expectedSha=[string]$meta.checksum; ` +
    `if($expectedSha -notmatch '^[A-Fa-f0-9]{64}$')` +
    `{throw "Breeze: release metadata did not include a valid SHA-256 checksum - refusing to install"}`;
  const winVerifyChecksum =
    `$actualSha=(Get-FileHash -Algorithm SHA256 -Path $exe).Hash; ` +
    `if($actualSha.ToUpper() -ne $expectedSha.ToUpper())` +
    `{throw "Breeze: downloaded agent binary checksum does not match the server's release metadata - refusing to install"}`;
  const winVerifySignature =
    `$sig=Get-AuthenticodeSignature $exe; ` +
    `if($sig.Status -ne 'NotSigned' -and $sig.Status -ne 'Valid')` +
    `{throw "Breeze: downloaded agent binary has an invalid or untrusted signature ($($sig.Status)) - refusing to install"}`;
  // Older Windows PowerShell 5.1 hosts (e.g. Windows Server 2016) can default
  // SecurityProtocol to Ssl3, Tls with no Tls12, which makes
  // Invoke-WebRequest fail before the agent is even downloaded ("Could not
  // create SSL/TLS secure channel", #4586). OR the flag into the existing
  // value rather than replacing it, so Tls13 stays enabled where present.
  const winTlsCheck =
    `[Net.ServicePointManager]::SecurityProtocol = ` +
    `[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12`;
  // A self-hosted server on a self-signed or private-CA certificate the
  // machine does not trust fails the download with PowerShell's raw
  // "underlying connection was closed" error (#4979). Translate only a server
  // certificate rejection into the actual fix -- verification is never
  // skipped -- and rethrow every other error untouched. The match is narrow on
  // purpose: PS 5.1 reports "Could not establish trust relationship for the
  // SSL/TLS secure channel", and both PS 5.1 and PS 7 carry an inner
  // AuthenticationException "The remote certificate is invalid ...". Bare
  // "certificate" / "trust relationship" would also catch unrelated errors
  // (client-certificate selection, the Windows domain-trust failure). The
  // innermost message (UntrustedRoot, RemoteCertificateNameMismatch, ...) is
  // kept, because the cause may be a name mismatch or expiry, not the CA.
  // GET /agent-versions/latest (above) and GET /agents/download/windows/amd64
  // are two independent requests that each resolve "latest"/"promoted"
  // separately at their own request time — a release promotion landing
  // between the two calls could hand back bytes for a different release than
  // the checksum was fetched for. Pin the download to the exact version the
  // metadata call returned, the same way the codebase already pins this
  // download route elsewhere (?version=, #5159), so the checksum and the
  // bytes always come from one release.
  const winDownloadUrl =
    `${apiUrl}/api/v1/agents/download/windows/amd64?version=$([uri]::EscapeDataString($meta.version))`;
  const winDownload =
    `try{Invoke-WebRequest -Uri "${winDownloadUrl}" -OutFile $exe}` +
    `catch{if("$($_.Exception)" -match 'remote certificate is invalid|establish trust relationship for the SSL/TLS')` +
    `{throw "Breeze: this machine rejected the TLS certificate of ${apiUrl} ($($_.Exception.GetBaseException().Message)). ` +
    `If the server uses a self-signed or private-CA certificate, import its root CA into Cert:\\LocalMachine\\Root; ` +
    `otherwise check that the certificate matches the server name and has not expired. ` +
    `See https://docs.breezermm.com/deploy/tls/#trusting-the-internal-ca-on-agents"}; throw}`;
  const windows =
    `$ErrorActionPreference='Stop'; ` +
    `${winOsFloorCheck}; ` +
    `${winTlsCheck}; ` +
    `${winFetchChecksum}; ` +
    `${winStageDir}; ` +
    `${winDownload}; ` +
    `${winMzCheck}; ` +
    `${winVerifySignature}; ` +
    `${winVerifyChecksum}; ` +
    // Enroll FIRST (#7576). `service install` stages the watchdog, and before
    // enrollment it has no persisted control plane to fetch it from: a hosted
    // build that allows several refuses outright, and the watchdog was never
    // installed. On an enrolled host `service install` also starts the service
    // and exits non-zero if the start fails, so there is no separate
    // `service start` (it would fail against the already-running service).
    `& $exe enroll "${token}" --server "${apiUrl}"${winSecretFlag}; ${winThrow('enrollment')}; ` +
    `& $exe service install; ${winThrow('service install')}`;

  return { windows, macos: unixCmd, linux: unixCmd };
}
