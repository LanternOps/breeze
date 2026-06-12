import { describe, expect, it } from 'vitest';
import { buildInstallCommands } from './installCommands';

const base = {
  apiUrl: 'https://rmm.example.com',
  ghBase: 'https://github.com/lanternops/breeze/releases/latest/download',
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
      expect(windows).toContain('breeze-agent-windows-amd64.exe');
    });

    it('checks $LASTEXITCODE after every agent invocation', () => {
      const { windows } = buildInstallCommands(base);
      // Native exe failures do not throw in PowerShell — each of the three
      // agent steps (service install, enroll, service start) needs a check.
      expect(windows.match(/if\(\$LASTEXITCODE\)\{throw/g)).toHaveLength(3);
      expect(windows).toContain('enroll "enroll_abc123" --server "https://rmm.example.com"');
    });

    it('appends --enrollment-secret only when a secret is provided', () => {
      const withSecret = buildInstallCommands({ ...base, enrollmentSecret: 's3cret' });
      expect(withSecret.windows).toContain('--enrollment-secret "s3cret"');
      expect(buildInstallCommands(base).windows).not.toContain('--enrollment-secret');
    });
  });

  it('strips trailing slashes from apiUrl and ghBase', () => {
    const cmds = buildInstallCommands({
      ...base,
      apiUrl: 'https://rmm.example.com/',
      ghBase: 'https://gh.example.com/dl/',
    });
    expect(cmds.macos).toContain('https://rmm.example.com/api/v1/agents/install.sh');
    expect(cmds.macos).not.toContain('com//');
    expect(cmds.windows).toContain('https://gh.example.com/dl/breeze-agent-windows-amd64.exe');
  });
});
