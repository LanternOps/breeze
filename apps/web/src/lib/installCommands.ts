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
  const winStageDir =
    `$d=Join-Path $env:TEMP 'breeze-install'; ` +
    `New-Item -ItemType Directory -Force -Path $d | Out-Null; ` +
    `$exe=Join-Path $d 'breeze-agent.exe'`;
  const winMzCheck =
    `$b=[IO.File]::ReadAllBytes($exe); ` +
    `if($b.Length -lt 2 -or $b[0] -ne 0x4D -or $b[1] -ne 0x5A)` +
    `{throw "Breeze: downloaded file is not a Windows executable - a captive portal or web filter may be intercepting this network"}`;
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
  // "underlying connection was closed" error (#4979). Translate only a
  // certificate failure into the actual fix -- trust the CA; verification is
  // never skipped -- and rethrow every other error untouched. Matching the
  // full exception text covers PS 5.1 (WebException, "Could not establish
  // trust relationship") and PS 7 (inner AuthenticationException, "remote
  // certificate is invalid").
  const winDownload =
    `try{Invoke-WebRequest -Uri "${apiUrl}/api/v1/agents/download/windows/amd64" -OutFile $exe}` +
    `catch{if("$($_.Exception)" -match 'certificate|trust relationship')` +
    `{throw "Breeze: this machine rejected the TLS certificate of ${apiUrl}. If the server uses a self-signed or private-CA certificate, ` +
    `import its root CA into Cert:\\LocalMachine\\Root and retry - see https://docs.breezermm.com/deploy/tls/#trusting-the-internal-ca-on-agents"}; throw}`;
  const windows =
    `$ErrorActionPreference='Stop'; ` +
    `${winOsFloorCheck}; ` +
    `${winTlsCheck}; ` +
    `${winStageDir}; ` +
    `${winDownload}; ` +
    `${winMzCheck}; ` +
    `& $exe service install; ${winThrow('service install')}; ` +
    `& $exe enroll "${token}" --server "${apiUrl}"${winSecretFlag}; ${winThrow('enrollment')}; ` +
    `& $exe service start; ${winThrow('service start')}`;

  return { windows, macos: unixCmd, linux: unixCmd };
}
