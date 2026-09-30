import { describe, expect, it } from 'vitest';
import { buildInstallCommands } from './installCommands';

const base = {
  apiUrl: 'https://rmm.example.com',
  token: 'enroll_abc123',
};

describe('buildInstallCommands', () => {
  describe('macOS / Linux (install.sh based)', () => {
    it('routes through the server-generated install.sh for both platforms', () => {
      const cmds = buildInstallCommands(base);
      for (const cmd of [cmds.macos, cmds.linux]) {
        expect(cmd).toContain('https://rmm.example.com/api/v1/agents/install.sh');
        expect(cmd).toContain('--server "https://rmm.example.com"');
        expect(cmd).toContain('--token "enroll_abc123"');
      }
      // The script auto-detects the OS; both platforms get the same command.
      expect(cmds.macos).toBe(cmds.linux);
    });

    it('downloads to a mktemp path and verifies the shebang before sudo bash', () => {
      const { macos } = buildInstallCommands(base);
      // Guards against an intercepting device serving HTML where the script
      // should be: never pipe straight into bash, check for #! first.
      expect(macos).toContain('mktemp');
      expect(macos).toContain("grep -q '^#!'");
      expect(macos).not.toContain('| sudo bash');
    });

    it('scopes the connectivity error to the fetch + shebang check', () => {
      const { macos } = buildInstallCommands(base);
      expect(macos).toContain('Could not fetch the Breeze installer from https://rmm.example.com');
      // The fallback must wrap only the fetch/verify group: install.sh prints
      // its own precise errors, so a failure inside `sudo bash` must NOT
      // trigger the "could not fetch" message.
      expect(macos.indexOf('Could not fetch')).toBeLessThan(macos.indexOf('sudo bash'));
      // Must surface a failing exit code without closing the user's shell.
      expect(macos).toContain('false; }');
      expect(macos).not.toContain('exit 1');
    });

    it('sends the error to stderr and bounds the bootstrap fetch', () => {
      const { macos } = buildInstallCommands(base);
      // MDM/RMM log collectors split streams — the actionable message must
      // land on stderr like install.sh's own errors do.
      expect(macos).toContain('>&2');
      // Against a DROP-style firewall the user should not stare at a silent
      // prompt for curl's ~2min default connect timeout.
      expect(macos).toContain('--connect-timeout 10');
    });

    it('appends --enrollment-secret only when a secret is provided', () => {
      const withSecret = buildInstallCommands({ ...base, enrollmentSecret: 's3cret' });
      expect(withSecret.macos).toContain('--enrollment-secret "s3cret"');
      expect(buildInstallCommands(base).macos).not.toContain('--enrollment-secret');
    });
  });

  describe('Windows (PowerShell)', () => {
    it('stops on download failure via $ErrorActionPreference', () => {
      const { windows } = buildInstallCommands(base);
      expect(windows.startsWith("$ErrorActionPreference='Stop';")).toBe(true);
      expect(windows).toContain('Invoke-WebRequest');
    });

    it('forces TLS 1.2 before the download for older PowerShell/.NET defaults (#4586)', () => {
      // Windows Server 2016 / PS 5.1 hosts can default SecurityProtocol to
      // Ssl3, Tls (no Tls12), which makes Invoke-WebRequest fail outright
      // with "Could not create SSL/TLS secure channel." Bitwise-OR the flag
      // in rather than replacing the value, so Tls13 (where present) stays
      // enabled alongside it.
      const { windows } = buildInstallCommands(base);
      expect(windows).toContain(
        '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12'
      );
      // Must run before the download, not after.
      expect(windows.indexOf('SecurityProtocol')).toBeLessThan(windows.indexOf('Invoke-WebRequest'));
    });

    it('names the certificate fix when the download fails TLS verification, and rethrows anything else (#4979)', () => {
      // A self-hosted server on a self-signed / private-CA certificate made the
      // download die with PowerShell's raw "underlying connection was closed"
      // error. The catch must translate ONLY a certificate failure (never skip
      // verification) and rethrow every other error untouched.
      const { windows } = buildInstallCommands(base);
      const tryIdx = windows.indexOf('try{Invoke-WebRequest');
      expect(tryIdx).toBeGreaterThan(-1);
      const catchBlock = windows.slice(windows.indexOf('catch{', tryIdx));
      // Narrow match only: bare "certificate" / "trust relationship" would
      // mislabel client-certificate and domain-trust failures.
      expect(catchBlock.startsWith(
        `catch{if("$($_.Exception)" -match 'remote certificate is invalid|establish trust relationship for the SSL/TLS'){throw "Breeze: `
      )).toBe(true);
      // The real cause (UntrustedRoot / NameMismatch / expiry) is kept, not overwritten.
      expect(catchBlock).toContain('$($_.Exception.GetBaseException().Message)');
      expect(catchBlock).toContain('matches the server name and has not expired');
      expect(catchBlock).toContain('Cert:\\LocalMachine\\Root');
      expect(catchBlock).toContain('https://rmm.example.com');
      expect(catchBlock).toContain('https://docs.breezermm.com/deploy/tls/#trusting-the-internal-ca-on-agents');
      // Bare rethrow for non-certificate failures, before the MZ check runs.
      expect(catchBlock.indexOf('"}; throw}')).toBeGreaterThan(-1);
      expect(catchBlock.indexOf('"}; throw}')).toBeLessThan(catchBlock.indexOf('ReadAllBytes'));
      // Never weaken verification.
      expect(windows).not.toMatch(/ServerCertificateValidationCallback|SkipCertificateCheck/);
    });

    it('downloads the agent from the server, not GitHub (#4441)', () => {
      // The server's download route is what serves BYO / self-hosted signed
      // binaries (BINARY_SOURCE=local, or a custom BINARY_GITHUB_REPOSITORY).
      // A hard-coded github.com URL bypasses that and hands a self-hoster the
      // upstream binary — the unix path already goes through install.sh on the
      // server, so Windows must match.
      const { windows } = buildInstallCommands(base);
      expect(windows).toContain(
        'Invoke-WebRequest -Uri "https://rmm.example.com/api/v1/agents/download/windows/amd64?version='
      );
      expect(windows).not.toContain('github.com');
    });

    it('checks $LASTEXITCODE after every agent invocation', () => {
      const { windows } = buildInstallCommands(base);
      // Native exe failures do not throw in PowerShell — each agent step
      // (enroll, service install) needs a check.
      const invocations = windows.match(/& \$exe /g) ?? [];
      expect(invocations).toHaveLength(2);
      expect(windows.match(/if\(\$LASTEXITCODE\)\{throw/g)).toHaveLength(invocations.length);
      expect(windows).toContain('enroll "enroll_abc123" --server "https://rmm.example.com"');
    });

    it('enrolls before `service install` so the install can stage the watchdog (#7576)', () => {
      // Before enrollment the watchdog bootstrap inside `service install` has no
      // persisted control plane; a hosted build that allows more than one
      // refuses to stage ("run `breeze-agent enroll` first, then re-run
      // `service install`"), so the old install-then-enroll order left the
      // device without a watchdog.
      const { windows } = buildInstallCommands(base);
      const enrollAt = windows.indexOf('& $exe enroll ');
      const installAt = windows.indexOf('& $exe service install');
      expect(enrollAt).toBeGreaterThan(-1);
      expect(installAt).toBeGreaterThan(enrollAt);
      // On an enrolled host `service install` starts the service itself and
      // exits non-zero if the start fails. A trailing `service start` would
      // then fail against the already-running service.
      expect(windows).not.toContain('service start');
    });

    it('verifies the download is a real PE executable before running it', () => {
      const { windows } = buildInstallCommands(base);
      // The Windows analog of the unix shebang check: a captive portal's 200
      // HTML saved as breeze-agent.exe must be blamed on the network, not
      // surface as PowerShell's raw "not a valid application" exception.
      expect(windows).toContain('0x4D');
      expect(windows).toContain('0x5A');
      expect(windows).toContain('captive portal or web filter');
      // The MZ check must run before the first agent invocation.
      expect(windows.indexOf('0x4D')).toBeLessThan(windows.indexOf('& $exe '));
    });

    it('downloads into a temp directory, never the shell working directory (#5898)', () => {
      // An elevated PowerShell starts in C:\Windows\system32. A relative
      // -OutFile puts the agent INSIDE System32, `service install` copies it
      // from there into Program Files, and Defender's ASR rule "Block use of
      // copied or impersonated system tools" (C0033C00-...) then denies every
      // open of the copy, even to SYSTEM - the service never starts.
      const { windows } = buildInstallCommands(base);
      expect(windows).toContain('$env:TEMP');
      expect(windows).not.toContain('-OutFile breeze-agent.exe');
      expect(windows).not.toContain('$pwd');
      expect(windows).not.toContain('.\\breeze-agent.exe');
      // The directory must exist before the download writes into it.
      expect(windows.indexOf('New-Item')).toBeLessThan(windows.indexOf('Invoke-WebRequest'));
      // Every agent invocation and the MZ check use the same absolute path.
      expect(windows.match(/\$exe/g)?.length).toBeGreaterThanOrEqual(5);
    });

    it('appends --enrollment-secret only when a secret is provided', () => {
      const withSecret = buildInstallCommands({ ...base, enrollmentSecret: 's3cret' });
      expect(withSecret.windows).toContain('--enrollment-secret "s3cret"');
      expect(buildInstallCommands(base).windows).not.toContain('--enrollment-secret');
    });

    it('blocks below Windows 10 / Server 2016 before downloading anything (#4608)', () => {
      // Go 1.22+ (the agent's pinned toolchain) cannot run below Windows 10 /
      // Server 2016 -- surface the same floor + message as the MSI
      // LaunchCondition (breeze.wxs) before wasting a download on a box that
      // can never run the agent.
      const { windows } = buildInstallCommands(base);
      expect(windows).toContain('OSVersion.Version');
      // Assert the actual comparison, not just surrounding text — a wrong
      // operator/threshold/field (-gt instead of -lt, .Minor instead of
      // .Major, a dropped `if`) would still leave the message text and
      // OSVersion.Version substring present.
      expect(windows).toContain('$osv.Major -lt 10');
      expect(windows).toContain('Windows 10 or Windows Server 2016 or later');
      expect(windows.indexOf('OSVersion')).toBeLessThan(windows.indexOf('Invoke-WebRequest'));
    });

    it('stages into a freshly created, uniquely named directory instead of a fixed predictable path', () => {
      const { windows } = buildInstallCommands(base);
      // A fixed name under $env:TEMP (e.g. 'breeze-install') can be
      // pre-created by another local principal before this script runs.
      // The staging directory name must vary per run (GUID/random) so it
      // cannot be pre-staged, and creation must fail rather than silently
      // adopt an existing directory of that name.
      expect(windows).toContain('[guid]::NewGuid()');
      expect(windows).not.toContain("Join-Path $env:TEMP 'breeze-install'");
      // No -Force on the staging directory creation: an existing directory at
      // that (random) path must cause an error, not be silently reused.
      const newItemMatch = windows.match(/New-Item -ItemType Directory[^;]*/);
      expect(newItemMatch).not.toBeNull();
      expect(newItemMatch![0]).not.toContain('-Force');
      expect(newItemMatch![0]).toContain('-ErrorAction Stop');
    });

    it('locks the staging directory ACL down to the current principal and SYSTEM', () => {
      const { windows } = buildInstallCommands(base);
      expect(windows).toContain('icacls');
      expect(windows).toContain('/inheritance:r');
      // SYSTEM via well-known SID, so this also works when the one-liner
      // itself is already running as SYSTEM (e.g. PsExec -s, Intune).
      expect(windows).toContain('S-1-5-18');
      expect(windows.indexOf('icacls')).toBeLessThan(windows.indexOf('Invoke-WebRequest'));
    });

    it('fetches the signed release checksum and verifies the download before executing anything', () => {
      const { windows } = buildInstallCommands(base);
      expect(windows).toContain('/api/v1/agent-versions/latest?platform=windows&arch=amd64&component=agent');
      expect(windows).toContain('Get-FileHash');
      expect(windows).toContain('SHA256');
      // Checksum must be verified before the executable is ever invoked.
      expect(windows.indexOf('Get-FileHash')).toBeLessThan(windows.indexOf('& $exe '));
      // A metadata fetch failure or a missing/malformed checksum must fail
      // closed rather than fall back to running the file unverified.
      expect(windows).toContain('refusing to install');
    });

    it('checks the Authenticode signature status when the binary is signed, failing closed on tampering', () => {
      const { windows } = buildInstallCommands(base);
      expect(windows).toContain('Get-AuthenticodeSignature');
      expect(windows.indexOf('Get-AuthenticodeSignature')).toBeLessThan(windows.indexOf('& $exe '));
    });

    it('pins the download to the exact version the checksum was fetched for', () => {
      // GET /agent-versions/latest and GET /agents/download/windows/amd64 are
      // two independent requests that each resolve "latest"/"promoted"
      // separately at their own request time. Without a shared pin, a
      // release promotion landing between the two calls can serve bytes for
      // a different release than the checksum was fetched for. The download
      // route already accepts an explicit ?version= to pin it to one exact
      // release (matches the existing pattern used elsewhere, #5159) — reuse
      // that instead of trusting the two calls to agree on their own.
      const { windows } = buildInstallCommands(base);
      expect(windows).toContain(
        'Invoke-WebRequest -Uri "https://rmm.example.com/api/v1/agents/download/windows/amd64?version=$([uri]::EscapeDataString($meta.version))" -OutFile $exe'
      );
      // The version must come from the same metadata fetch the checksum is
      // read from, not a second independent call.
      expect(windows.indexOf('$meta=Invoke-RestMethod')).toBeLessThan(windows.indexOf('$meta.version'));
    });
  });

  it('never interpolates a bare $identifier immediately followed by a colon inside a double-quoted string', () => {
    // Inside a double-quoted PowerShell string, "$name:" is parsed as a
    // drive-qualified variable reference (equivalent to ${name:...}), not as
    // the variable "$name" followed by a literal colon — PowerShell raises a
    // hard parse error unless "name" happens to be a real PSDrive (env,
    // global, script, local, function, variable, alias, cert, hklm, hkcu,
    // wsman, ...). Any other bare "$identifier:" inside a double-quoted
    // string aborts the whole one-liner before a single statement runs.
    // Wrap the variable in braces ("${identifier}:") to interpolate it
    // safely and unambiguously instead.
    const knownDriveQualifiedPrefixes = new Set([
      'env',
      'global',
      'script',
      'local',
      'private',
      'function',
      'variable',
      'alias',
      'cert',
      'hklm',
      'hkcu',
      'hkcr',
      'hkey_local_machine',
      'hkey_current_user',
      'wsman',
    ]);
    const { windows } = buildInstallCommands(base);
    const offenders: string[] = [];
    for (const dq of windows.match(/"(?:[^"\\]|\\.)*"/g) ?? []) {
      for (const m of dq.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*):/g)) {
        if (!knownDriveQualifiedPrefixes.has(m[1].toLowerCase())) {
          offenders.push(`${m[0]} in ${dq}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('strips trailing slashes from apiUrl', () => {
    const cmds = buildInstallCommands({
      ...base,
      apiUrl: 'https://rmm.example.com/',
    });
    expect(cmds.macos).toContain('https://rmm.example.com/api/v1/agents/install.sh');
    expect(cmds.macos).not.toContain('com//');
    expect(cmds.windows).toContain('https://rmm.example.com/api/v1/agents/download/windows/amd64');
    expect(cmds.windows).not.toContain('com//');
  });
});
