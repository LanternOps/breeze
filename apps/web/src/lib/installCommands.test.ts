import { describe, expect, it } from 'vitest';
import { windowsInstallerIntegritySchema } from '@breeze/shared';
import { buildInstallCommands, type InstallCommandOptions } from './installCommands';

const base = {
  apiUrl: 'https://rmm.example.com',
  token: 'enroll_abc123',
  windowsInstaller: windowsInstallerIntegritySchema.parse({
    url: 'https://rmm.example.com/api/v1/agents/install.ps1',
    sha256: 'a'.repeat(64),
  }),
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
    const commandFor = (options: InstallCommandOptions = base) => {
      const command = buildInstallCommands(options).windows;
      if (command === null) throw new Error('Expected a verified Windows command');
      return command;
    };

    it('hashes the downloaded bytes before decoding or executing them', () => {
      const windows = commandFor();
      const fetchStart = windows.indexOf('iwr ');
      const fetchRequest = windows.slice(fetchStart, windows.indexOf(';', fetchStart));
      expect(windows.startsWith("& { $ErrorActionPreference='Stop';")).toBe(true);
      expect(fetchRequest).toContain("iwr 'https://rmm.example.com/api/v1/agents/install.ps1'");
      expect(fetchRequest).toContain('-UseBasicParsing -TimeoutSec 10 -MaximumRedirection 0');
      expect(fetchRequest).toContain("-UserAgent 'BreezeInstaller/1.0'");
      expect(fetchRequest).not.toContain(base.token);
      expect(windows).toContain('if($r.StatusCode -ne 200)');
      expect(windows).toContain('$r.RawContentStream.Position=0');
      expect(windows).toContain('Get-FileHash -Algorithm SHA256 -InputStream $r.RawContentStream');
      expect(windows).toContain(base.windowsInstaller.sha256);
      expect(windows.indexOf('Get-FileHash')).toBeLessThan(windows.indexOf('GetString'));
      expect(windows.indexOf('installer checksum mismatch')).toBeLessThan(windows.indexOf('iex '));
      expect(windows.indexOf('iex ')).toBeLessThan(windows.indexOf('Install-BreezeAgent -Token'));
      expect(windows).toContain("Install-BreezeAgent -Token 'enroll_abc123'");
      expect(windows).not.toContain('$r.Content');
      expect(windows).not.toContain('-notmatch');
    });

    it('uses only the authenticated installer URL for the Windows download', () => {
      const windows = commandFor({ ...base, apiUrl: 'https://dashboard.example.com' });
      expect(windows).toContain(base.windowsInstaller.url);
      expect(windows).not.toContain('dashboard.example.com');
    });

    it('passes the optional enrollment secret as a literal function argument', () => {
      const windows = commandFor({ ...base, enrollmentSecret: "s'$(Get-Item .)" });
      expect(windows).toContain("-EnrollmentSecret 's''$(Get-Item .)'");
      expect(windows.slice(0, windows.indexOf('Install-BreezeAgent -Token'))).not.toContain('Get-Item');
      expect(commandFor()).not.toContain('-EnrollmentSecret');
    });

    it('withholds Windows commands without trusted metadata while keeping Unix installation', () => {
      const commands = buildInstallCommands({ ...base, windowsInstaller: null });
      expect(commands.windows).toBeNull();
      expect(commands.linux).toContain('install.sh');
      expect(commands.linux).toContain(base.token);
    });
  });

  it('strips trailing slashes from apiUrl', () => {
    const cmds = buildInstallCommands({
      ...base,
      apiUrl: 'https://rmm.example.com/',
    });
    expect(cmds.macos).toContain('https://rmm.example.com/api/v1/agents/install.sh');
    expect(cmds.macos).not.toContain('com//');
    expect(cmds.windows).toContain('https://rmm.example.com/api/v1/agents/install.ps1');
    expect(cmds.windows).not.toContain('com//');
  });
});
