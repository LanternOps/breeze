import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/s3Storage', () => ({
  isS3Configured: vi.fn(() => false),
  getPresignedUrl: vi.fn(),
  isS3NotFound: (err: unknown) => {
    const name = (err as { name?: string }).name;
    return name === 'NotFound' || name === 'NoSuchKey';
  },
}));

vi.mock('../../services/binarySource', () => ({
  getBinarySource: vi.fn(() => 'local'),
  getGithubAgentUrl: vi.fn(),
  getGithubAgentPkgUrl: vi.fn(),
  getGithubHelperUrl: vi.fn(),
  getGithubUserHelperUrl: vi.fn(),
  getGithubWatchdogUrl: vi.fn(),
  HELPER_FILENAMES: {
    linux: 'breeze-desktop-helper-linux-amd64',
    darwin: 'breeze-desktop-helper-darwin',
    windows: 'breeze-desktop-helper-windows.exe',
  },
}));

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadRoutes } from './download';
import { getBinarySource, getGithubAgentPkgUrl, getGithubUserHelperUrl, getGithubWatchdogUrl } from '../../services/binarySource';
import { isS3Configured, getPresignedUrl } from '../../services/s3Storage';

describe('public agent binary downloads', () => {
  const originalAgentDir = process.env.AGENT_BINARY_DIR;
  const originalHelperDir = process.env.HELPER_BINARY_DIR;

  beforeEach(() => {
    process.env.AGENT_BINARY_DIR = '/tmp/breeze-secret-agent-binaries';
    process.env.HELPER_BINARY_DIR = '/tmp/breeze-secret-helper-binaries';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.AGENT_BINARY_DIR;
    else process.env.AGENT_BINARY_DIR = originalAgentDir;
    if (originalHelperDir === undefined) delete process.env.HELPER_BINARY_DIR;
    else process.env.HELPER_BINARY_DIR = originalHelperDir;
    vi.restoreAllMocks();
  });

  it('does not disclose AGENT_BINARY_DIR in public 404 responses', async () => {
    const res = await downloadRoutes.request('/download/linux/amd64');
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain('/tmp/breeze-secret-agent-binaries');
    expect(body).not.toContain('AGENT_BINARY_DIR');
    expect(console.warn).toHaveBeenCalledWith(
      '[agent-download] Local binary missing',
      { filename: 'breeze-agent-linux-amd64' },
    );
  });

  it('does not disclose HELPER_BINARY_DIR in public 404 responses', async () => {
    const res = await downloadRoutes.request('/download/helper/linux/amd64');
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain('/tmp/breeze-secret-helper-binaries');
    expect(body).not.toContain('HELPER_BINARY_DIR');
    expect(console.warn).toHaveBeenCalledWith(
      '[helper-download] Local binary missing',
      { filename: 'breeze-desktop-helper-linux-amd64' },
    );
  });

  it('does not disclose AGENT_BINARY_DIR in public watchdog 404 responses', async () => {
    // The watchdog binary is served from the same dir as the agent. The route
    // must exist (404, not 404-route-not-found) and not leak the path.
    const res = await downloadRoutes.request('/download/watchdog/linux/amd64');
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain('/tmp/breeze-secret-agent-binaries');
    expect(console.warn).toHaveBeenCalledWith(
      '[watchdog-download] Local binary missing',
      { filename: 'breeze-watchdog-linux-amd64' },
    );
  });

  it('redirects watchdog downloads to GitHub in github mode (per-arch, .exe on windows)', async () => {
    vi.mocked(getBinarySource).mockReturnValue('github');
    vi.mocked(getGithubWatchdogUrl).mockImplementation(
      (os: string, arch: string) =>
        `https://github.test/${os}-${arch}/breeze-watchdog`,
    );

    try {
      const lin = await downloadRoutes.request('/download/watchdog/linux/amd64');
      expect(lin.status).toBe(302);
      expect(lin.headers.get('location')).toBe('https://github.test/linux-amd64/breeze-watchdog');
      expect(getGithubWatchdogUrl).toHaveBeenCalledWith('linux', 'amd64');

      const win = await downloadRoutes.request('/download/watchdog/windows/amd64');
      expect(win.status).toBe(302);
      expect(getGithubWatchdogUrl).toHaveBeenCalledWith('windows', 'amd64');
    } finally {
      // Restore the module-mock default so later tests still see 'local'
      // (vi.restoreAllMocks does not reset vi.mock factory fns).
      vi.mocked(getBinarySource).mockReturnValue('local');
    }
  });

  it('rejects invalid OS/arch on the watchdog route', async () => {
    const badOs = await downloadRoutes.request('/download/watchdog/solaris/amd64');
    expect(badOs.status).toBe(400);
    const badArch = await downloadRoutes.request('/download/watchdog/linux/sparc');
    expect(badArch.status).toBe(400);
  });

  // #1878: user-helper (breeze-user-helper.exe) is a distinct Go binary from the
  // Tauri "helper" app, and its server-relative route must exist so the agent's
  // verified updater is not handed a github.com URL its host check rejects.
  it('does not disclose AGENT_BINARY_DIR in public user-helper 404 responses', async () => {
    const res = await downloadRoutes.request('/download/user-helper/windows/amd64');
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain('/tmp/breeze-secret-agent-binaries');
    expect(console.warn).toHaveBeenCalledWith(
      '[user-helper-download] Local binary missing',
      { filename: 'breeze-user-helper-windows-amd64.exe' },
    );
  });

  it('redirects user-helper downloads to GitHub in github mode (per-arch, .exe on windows)', async () => {
    vi.mocked(getBinarySource).mockReturnValue('github');
    vi.mocked(getGithubUserHelperUrl).mockImplementation(
      (os: string, arch: string) =>
        `https://github.test/${os}-${arch}/breeze-user-helper`,
    );

    try {
      const win = await downloadRoutes.request('/download/user-helper/windows/amd64');
      expect(win.status).toBe(302);
      expect(win.headers.get('location')).toBe('https://github.test/windows-amd64/breeze-user-helper');
      expect(getGithubUserHelperUrl).toHaveBeenCalledWith('windows', 'amd64');
    } finally {
      vi.mocked(getBinarySource).mockReturnValue('local');
    }
  });

  it('rejects invalid OS/arch on the user-helper route', async () => {
    const badOs = await downloadRoutes.request('/download/user-helper/solaris/amd64');
    expect(badOs.status).toBe(400);
    const badArch = await downloadRoutes.request('/download/user-helper/windows/sparc');
    expect(badArch.status).toBe(400);
  });

  it('serves the architecture-matched pkg from local disk in non-github mode', async () => {
    // Intel Macs hitting the per-arch pkg endpoint must resolve to the amd64
    // package, not a hardcoded arm64 one (the "Bad CPU type" regression).
    const res = await downloadRoutes.request('/download/darwin/amd64/pkg');
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain('/tmp/breeze-secret-agent-binaries');
    expect(console.warn).toHaveBeenCalledWith(
      '[pkg-download] Local package missing',
      { filename: 'breeze-agent-darwin-amd64.pkg' },
    );
  });

  it('rejects non-darwin pkg requests', async () => {
    const res = await downloadRoutes.request('/download/linux/amd64/pkg');
    expect(res.status).toBe(400);
  });
});

describe('S3 transport failures surface as 500, not a masked 404 (issue #1802)', () => {
  const originalAgentDir = process.env.AGENT_BINARY_DIR;
  const originalHelperDir = process.env.HELPER_BINARY_DIR;

  beforeEach(() => {
    // Point at non-existent dirs so any disk fallback would 404 — proving the
    // 500 comes from the S3 guard, not from a disk hit.
    process.env.AGENT_BINARY_DIR = '/tmp/breeze-nonexistent-agent-binaries';
    process.env.HELPER_BINARY_DIR = '/tmp/breeze-nonexistent-helper-binaries';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(getBinarySource).mockReturnValue('local');
    vi.mocked(isS3Configured).mockReturnValue(true);
    vi.mocked(getPresignedUrl).mockRejectedValue(
      Object.assign(new Error('credentials expired'), { name: 'CredentialsProviderError' }),
    );
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.AGENT_BINARY_DIR;
    else process.env.AGENT_BINARY_DIR = originalAgentDir;
    if (originalHelperDir === undefined) delete process.env.HELPER_BINARY_DIR;
    else process.env.HELPER_BINARY_DIR = originalHelperDir;
    vi.restoreAllMocks();
    vi.mocked(getBinarySource).mockReset();
    vi.mocked(isS3Configured).mockReset();
    vi.mocked(getPresignedUrl).mockReset();
  });

  it.each([
    ['agent', '/download/linux/amd64', '[agent-download]'],
    ['helper', '/download/helper/linux/amd64', '[helper-download]'],
    ['watchdog', '/download/watchdog/linux/amd64', '[watchdog-download]'],
    ['user-helper', '/download/user-helper/windows/amd64', '[user-helper-download]'],
  ])('returns 500 for the %s route on a non-NotFound S3 error', async (_name, path, logTag) => {
    const res = await downloadRoutes.request(path);
    const body = await res.text();

    expect(res.status).toBe(500);
    expect(body).not.toContain('not available');
    expect(body).not.toContain('/tmp');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`${logTag} S3 presign failed`),
      expect.anything(),
    );
  });

  it.each([
    ['agent', '/download/linux/amd64', '[agent-download]', 'NotFound'],
    ['helper', '/download/helper/linux/amd64', '[helper-download]', 'NoSuchKey'],
    ['watchdog', '/download/watchdog/linux/amd64', '[watchdog-download]', 'NotFound'],
    ['user-helper', '/download/user-helper/windows/amd64', '[user-helper-download]', 'NotFound'],
  ])(
    'still falls back to disk and 404s for the %s route when the S3 object genuinely does not exist',
    async (_name, path, logTag, errName) => {
      vi.mocked(getPresignedUrl).mockRejectedValue(
        Object.assign(new Error('missing'), { name: errName }),
      );
      const res = await downloadRoutes.request(path);

      expect(res.status).toBe(404);
      // The genuine miss must be a warn-level fall-through, never the 500 error path.
      expect(console.error).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining(`${logTag} S3 object missing`),
        expect.anything(),
      );
    },
  );

  it('treats an S3 error with no identifiable name as a transport fault (500), not a missing object', async () => {
    // The whole fix hinges on the conservative default: anything we cannot
    // positively classify as NotFound/NoSuchKey must surface as a 500, never be
    // swallowed by the disk fallback. A future refactor that defaulted unknown
    // errors to "not found" would silently reintroduce the #1802 masking bug —
    // this pins the boundary. A bare Error has name 'Error' (not NotFound).
    vi.mocked(getPresignedUrl).mockRejectedValue(new Error('opaque failure'));
    const res = await downloadRoutes.request('/download/linux/amd64');

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalled();
  });
});

describe('public agent .pkg downloads — per-arch serving', () => {
  const originalAgentDir = process.env.AGENT_BINARY_DIR;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'breeze-pkg-'));
    process.env.AGENT_BINARY_DIR = tmp;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(getBinarySource).mockReturnValue('local');
    vi.mocked(isS3Configured).mockReturnValue(false);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (originalAgentDir === undefined) delete process.env.AGENT_BINARY_DIR;
    else process.env.AGENT_BINARY_DIR = originalAgentDir;
    vi.restoreAllMocks();
    vi.mocked(getBinarySource).mockReset();
    vi.mocked(isS3Configured).mockReset();
    vi.mocked(getPresignedUrl).mockReset();
    vi.mocked(getGithubAgentPkgUrl).mockReset();
  });

  it('serves amd64 and arm64 as DISTINCT packages (the Bad CPU type regression guard)', async () => {
    // The whole point of the fix: each arch must resolve to its OWN file, never
    // a hardcoded one. Write distinct bodies and prove they come back distinct.
    writeFileSync(join(tmp, 'breeze-agent-darwin-amd64.pkg'), 'AMD64-PKG-BODY');
    writeFileSync(join(tmp, 'breeze-agent-darwin-arm64.pkg'), 'ARM64-PKG-BODY');

    const amd = await downloadRoutes.request('/download/darwin/amd64/pkg');
    const arm = await downloadRoutes.request('/download/darwin/arm64/pkg');

    expect(amd.status).toBe(200);
    expect(arm.status).toBe(200);
    expect(amd.headers.get('content-disposition')).toContain('breeze-agent-darwin-amd64.pkg');
    expect(arm.headers.get('content-disposition')).toContain('breeze-agent-darwin-arm64.pkg');

    const amdBody = await amd.text();
    const armBody = await arm.text();
    expect(amdBody).toBe('AMD64-PKG-BODY');
    expect(armBody).toBe('ARM64-PKG-BODY');
    expect(amdBody).not.toBe(armBody);
  });

  it('redirects to the GitHub release asset in github mode', async () => {
    vi.mocked(getBinarySource).mockReturnValue('github');
    vi.mocked(getGithubAgentPkgUrl).mockReturnValue(
      'https://github.test/breeze-agent-darwin-amd64.pkg',
    );

    const res = await downloadRoutes.request('/download/darwin/amd64/pkg');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://github.test/breeze-agent-darwin-amd64.pkg');
    expect(getGithubAgentPkgUrl).toHaveBeenCalledWith('darwin', 'amd64');
  });

  it('redirects to a presigned S3 URL for the requested arch when S3 is configured', async () => {
    vi.mocked(isS3Configured).mockReturnValue(true);
    vi.mocked(getPresignedUrl).mockResolvedValue('https://s3.test/presigned-arm64');

    const res = await downloadRoutes.request('/download/darwin/arm64/pkg');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://s3.test/presigned-arm64');
    expect(getPresignedUrl).toHaveBeenCalledWith('agent/breeze-agent-darwin-arm64.pkg');
  });

  it('falls back to disk (and warns) when the S3 object is missing', async () => {
    vi.mocked(isS3Configured).mockReturnValue(true);
    vi.mocked(getPresignedUrl).mockRejectedValue(
      Object.assign(new Error('not found'), { name: 'NoSuchKey' }),
    );
    // No file on disk → 404 after fallback; the S3 miss is logged at warn (not error).
    const res = await downloadRoutes.request('/download/darwin/amd64/pkg');

    expect(res.status).toBe(404);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[pkg-download] S3 object missing'),
      expect.anything(),
    );
  });

  it('returns 500 (not a masked 404) when the S3 presign fails with a transport/auth error', async () => {
    // issue #1802 item 3: a non-NotFound S3 fault (network/credentials/throttle)
    // must NOT fall through to disk and 404 — on hosted infra there are no
    // binaries on disk, so the real error would be hidden as "package not found".
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(isS3Configured).mockReturnValue(true);
    vi.mocked(getPresignedUrl).mockRejectedValue(
      Object.assign(new Error('connection reset'), { name: 'TimeoutError' }),
    );

    const res = await downloadRoutes.request('/download/darwin/amd64/pkg');
    const body = await res.text();

    expect(res.status).toBe(500);
    // Must not be masked as a not-found, and must not leak internals.
    expect(body).not.toContain('not found');
    expect(body).not.toContain('/tmp');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[pkg-download] S3 presign failed'),
      expect.anything(),
    );
  });
});

describe('GET /install.sh — generated installer script', () => {
  async function fetchScript(): Promise<string> {
    const res = await downloadRoutes.request('/install.sh');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    return res.text();
  }

  it('does not derive the production server URL from the request host', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalBreezeServer = process.env.BREEZE_SERVER;
    const originalPublicApiUrl = process.env.PUBLIC_API_URL;
    const originalApiUrl = process.env.API_URL;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.BREEZE_SERVER;
      delete process.env.PUBLIC_API_URL;
      delete process.env.API_URL;

      const res = await downloadRoutes.request('https://attacker.example/install.sh');
      const body = await res.text();

      expect(res.status).toBe(503);
      expect(body).not.toContain('attacker.example');
      expect(body).not.toContain('https://attacker.example');
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalBreezeServer === undefined) delete process.env.BREEZE_SERVER;
      else process.env.BREEZE_SERVER = originalBreezeServer;
      if (originalPublicApiUrl === undefined) delete process.env.PUBLIC_API_URL;
      else process.env.PUBLIC_API_URL = originalPublicApiUrl;
      if (originalApiUrl === undefined) delete process.env.API_URL;
      else process.env.API_URL = originalApiUrl;
    }
  });

  it('is valid bash (bash -n syntax check)', async () => {
    const script = await fetchScript();
    const tmp = mkdtempSync(join(tmpdir(), 'breeze-install-sh-'));
    const file = join(tmp, 'install.sh');
    try {
      writeFileSync(file, script);
      // Throws (failing the test) on any syntax error.
      execFileSync('bash', ['-n', file]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('restores the SELinux context on the installed Linux binary (issue #1389)', async () => {
    const script = await fetchScript();
    // Without this, the binary keeps the mktemp user_tmp_t label after the mv
    // and systemd fails to exec it (203/EXEC) on SELinux-enforcing hosts. The
    // restorecon must be guarded so it is a no-op on non-SELinux systems.
    expect(script).toContain('command -v restorecon');
    expect(script).toMatch(/restorecon -v "\$INSTALL_DIR\/\$BINARY_NAME"/);
  });

  it('accepts a --token argument for enrollment-key based enrollment', async () => {
    const script = await fetchScript();
    // Argument parser handles --token and forwards it to `enroll` as the
    // positional enrollment key (the flow the Add Device UI uses).
    expect(script).toContain('--token)');
    expect(script.match(/ENROLL_ARGS=\(enroll\)/g)).toHaveLength(2);
    // The token and conditional secret must be appended in BOTH the darwin
    // and linux branches — a single match means one platform lost enrollment.
    expect(script.match(/ENROLL_ARGS\+=\("\$BREEZE_ENROLL_TOKEN"\)/g)).toHaveLength(2);
    expect(
      script.match(/ENROLL_ARGS\+=\(--enrollment-secret "\$BREEZE_ENROLLMENT_SECRET"\)/g),
    ).toHaveLength(2);
  });

  it('requires the enrollment token, treating --enrollment-secret as a supplement', async () => {
    const script = await fetchScript();
    // The token is mandatory end-to-end (agent `enroll` takes it as a required
    // positional arg; the server resolves the org/site from it). The validation
    // must gate on the token alone, NOT on "token OR secret" — a secret-only
    // invocation used to pass here and then die at the last step with cobra's
    // "accepts 1 arg(s), received 0".
    expect(script).toContain('An enrollment token is required. Pass --token TOKEN');
    // The old token-OR-secret acceptance must be gone.
    expect(script).not.toContain('-z "$BREEZE_ENROLL_TOKEN" && -z "$BREEZE_ENROLLMENT_SECRET"');
    expect(script).not.toContain('An enrollment credential is required');
    expect(script).not.toContain('BREEZE_ENROLLMENT_SECRET is required');
  });

  it('pre-flights connectivity via the /api version-metadata endpoint, not apex /health', async () => {
    const script = await fetchScript();
    // Probes an /api/* path the install actually depends on. A reverse proxy
    // that forwards /api/* but not bare /health must not false-abort the
    // install (#1470), so the pre-flight must NOT hit /health.
    expect(script).toContain('"$VERSION_METADATA_URL"');
    expect(script).toContain('agent-versions/latest');
    // The probe must not target apex /health (the #1470 regression).
    expect(script).not.toContain('"$BREEZE_SERVER/health"');
    expect(script).toContain('Cannot reach the Breeze');
  });

  it('diagnoses TLS failures distinctly from generic unreachability', async () => {
    const script = await fetchScript();
    // curl exit 60 (cert verify) / 35 (handshake) are the signature of both
    // self-signed-cert misconfigurations and TLS-intercepting middleboxes —
    // "check DNS/firewall" would be the wrong advice for either.
    expect(script).toContain('TLS problem connecting to');
  });

  it('flags intercepted responses (captive portal / wrong responder) distinctly', async () => {
    const script = await fetchScript();
    // A 200 whose body is HTML almost always means an intercepting device
    // answered (captive portal, router, web filter) — the guest-VLAN field
    // report behind this feature. The message must say so instead of letting
    // `installer` fail cryptically.
    expect(script).toContain('captive portal');
  });

  it('documents --token usage in the script header', async () => {
    const script = await fetchScript();
    expect(script).toContain('--token YOUR_ENROLLMENT_TOKEN');
  });
});

describe('GET /uninstall.sh — generated uninstaller script', () => {
  async function fetchScript(): Promise<string> {
    const res = await downloadRoutes.request('/uninstall.sh');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-disposition')).toBeNull();
    return res.text();
  }

  it('is valid bash (bash -n syntax check)', async () => {
    const script = await fetchScript();
    const tmp = mkdtempSync(join(tmpdir(), 'breeze-uninstall-sh-'));
    const file = join(tmp, 'uninstall.sh');
    try {
      writeFileSync(file, script);
      execFileSync('bash', ['-n', file]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('detects macOS and Linux instead of relying on separate scripts', async () => {
    const script = await fetchScript();
    expect(script).toContain('Darwin*) uninstall_macos');
    expect(script).toContain('Linux*) uninstall_linux');
    expect(script).toContain('launchctl bootout system/com.breeze.agent');
    expect(script).toContain('systemctl stop breeze-agent');
  });

  it('matches the checked-in web and agent script copies', async () => {
    const script = await fetchScript();
    const webScript = readFileSync(
      join(import.meta.dirname, '../../../../web/public/scripts/uninstall.sh'),
      'utf8',
    );
    const agentScript = readFileSync(
      join(import.meta.dirname, '../../../../../agent/scripts/install/uninstall.sh'),
      'utf8',
    );

    expect(script).toBe(webScript);
    expect(agentScript).toBe(webScript);
  });
});

describe('install.sh functional pre-flight behavior', () => {
  // Runs the real generated script with bash. An `id` PATH shim (always
  // prints 0, emulating `id -u` under root) makes the script's root check
  // pass so execution reaches the connectivity pre-flight. If the root check
  // ever stops using `id`, these tests fail on the root-check fatal — update
  // the shim to match.
  let tmp: string;
  let scriptFile: string;
  let shimDir: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'breeze-install-fn-'));
    scriptFile = join(tmp, 'install.sh');
    shimDir = join(tmp, 'bin');
    const res = await downloadRoutes.request('/install.sh');
    writeFileSync(scriptFile, await res.text());
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function runScript(
    args: string[],
  ): Promise<{ code: number; killed: boolean; output: string }> {
    return new Promise((resolve) => {
      execFile(
        'bash',
        [scriptFile, ...args],
        {
          env: {
            ...process.env,
            PATH: `${shimDir}:${process.env.PATH}`,
            // curl must hit 127.0.0.1 directly — a developer/CI proxy would
            // turn "connection refused" into a proxy response.
            no_proxy: '*',
            NO_PROXY: '*',
          },
          timeout: 30_000,
        },
        (err, stdout, stderr) => {
          const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
          // A timeout kill also lands here with code mapped to 1 — expose it
          // so "fails fast" tests can't pass on a script that printed the
          // right message but then hung.
          const killed = Boolean(err && (err.killed || err.signal));
          resolve({ code, killed, output: `${stdout}${stderr}` });
        },
      );
    });
  }

  it('fails fast with a clear message when the server is unreachable', async () => {
    // Port 1 on localhost → immediate connection refused.
    const { code, killed, output } = await runScript([
      '--server',
      'http://127.0.0.1:1',
      '--token',
      'tok',
    ]);
    expect(killed).toBe(false);
    expect(code).not.toBe(0);
    expect(output).toContain('Cannot reach the Breeze server');
    expect(output).toContain('no response');
  });

  it('flags a captive portal that answers 200 with a non-Breeze body', async () => {
    // The guest-VLAN field report: an intercepting device returns 200 HTML,
    // which previously sailed past `curl -f` and died inside `installer`.
    const portal = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>Guest network portal</body></html>');
    });
    await new Promise<void>((resolve) => portal.listen(0, '127.0.0.1', resolve));
    const { port } = portal.address() as AddressInfo;
    try {
      const { code, killed, output } = await runScript([
        '--server',
        `http://127.0.0.1:${port}`,
        '--token',
        'tok',
      ]);
      expect(killed).toBe(false);
      expect(code).not.toBe(0);
      expect(output).toContain('captive portal');
      expect(output).not.toContain('Downloading');
    } finally {
      portal.close();
    }
  });

  it('attributes an intercepted binary download to the network after a clean pre-flight', async () => {
    // A path-selective middlebox that allowlists the metadata endpoint (so the
    // pre-flight passes) but serves HTML where the binary/pkg should be. The
    // tampered download must still be rejected after the pre-flight — not
    // installed, and not blamed on Gatekeeper.
    const filter = createServer((req, res) => {
      if (req.url?.startsWith('/api/v1/agent-versions/latest')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '1.2.3', downloadUrl: '/dl', checksum: 'a'.repeat(64) }));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>Filtered</body></html>');
      }
    });
    await new Promise<void>((resolve) => filter.listen(0, '127.0.0.1', resolve));
    const { port } = filter.address() as AddressInfo;
    try {
      const { code, killed, output } = await runScript([
        '--server',
        `http://127.0.0.1:${port}`,
        '--token',
        'tok',
      ]);
      expect(killed).toBe(false);
      expect(code).not.toBe(0);
      expect(output).toContain('Breeze server is reachable');
      // Past the clean pre-flight the tampered download is rejected: linux by the
      // checksum mismatch, macOS by the .pkg xar-magic interception guard.
      expect(output).toMatch(/Checksum verification failed|intercepting/);
      expect(output).not.toContain('Gatekeeper');
    } finally {
      filter.close();
    }
  });

  it('rejects a missing enrollment token with guidance', async () => {
    const { code, output } = await runScript(['--server', 'http://127.0.0.1:1']);
    expect(code).not.toBe(0);
    expect(output).toContain('An enrollment token is required. Pass --token TOKEN');
  });

  it('rejects a secret-only invocation at validation (issue #1274), before installing anything', async () => {
    // The bug: --enrollment-secret without --token passed the script's own
    // credential check, installed the agent, and then died at the very last
    // step with cobra's "accepts 1 arg(s), received 0" — because the agent's
    // `enroll` requires the enrollment key as a positional arg and the server
    // resolves the org/site from it. The fix makes the script fail fast at the
    // first step (validation), never reaching the connectivity pre-flight or
    // download.
    const { code, output } = await runScript([
      '--server',
      'http://127.0.0.1:1',
      '--enrollment-secret',
      'sec',
    ]);
    expect(code).not.toBe(0);
    expect(output).toContain('An enrollment token is required. Pass --token TOKEN');
    // Must die at validation, NOT proceed to connectivity/download.
    expect(output).not.toContain('Checking connectivity');
    expect(output).not.toContain('Cannot reach the Breeze server');
  });

  it('accepts --token plus --enrollment-secret together past credential validation', async () => {
    const { code, output } = await runScript([
      '--server',
      'http://127.0.0.1:1',
      '--token',
      'tok',
      '--enrollment-secret',
      'sec',
    ]);
    // The supplementary secret is allowed alongside the required token; the run
    // proceeds to the connectivity pre-flight and dies there (nothing listening).
    expect(code).not.toBe(0);
    expect(output).not.toContain('An enrollment token is required');
    expect(output).toContain('Cannot reach the Breeze server');
  });

  it('proceeds past the pre-flight when the agent-versions endpoint returns real metadata', async () => {
    // Guards against a pre-flight that ALWAYS fails — which would still pass the
    // failure-oriented tests above while bricking every real install. The probe
    // must accept a genuine /api/v1/agent-versions/latest response and continue.
    const breeze = createServer((req, res) => {
      if (req.url?.startsWith('/api/v1/agent-versions/latest')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '1.2.3', downloadUrl: '/dl', checksum: 'a'.repeat(64) }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    await new Promise<void>((resolve) => breeze.listen(0, '127.0.0.1', resolve));
    const { port } = breeze.address() as AddressInfo;
    try {
      const { code, output } = await runScript(['--server', `http://127.0.0.1:${port}`, '--token', 'tok']);
      expect(output).toContain('Breeze server is reachable');
      expect(output).not.toContain('Cannot reach the Breeze');
      expect(output).not.toContain('captive portal');
      // It then fails at the download step (the fake server 404s the binary) —
      // beyond the pre-flight under test, but proof it got there.
      expect(code).not.toBe(0);
      expect(output).toContain('Failed to');
    } finally {
      breeze.close();
    }
  });

  it('passes the pre-flight when /health 404s but /api/* is served (the #1470 reverse proxy)', async () => {
    // The exact #1470 deployment: a reverse proxy forwards /api/* to the API but
    // returns the web app's 404 page for apex /health. The pre-flight must not
    // depend on /health — it must pass on the metadata endpoint alone.
    const proxy = createServer((req, res) => {
      if (req.url?.startsWith('/api/v1/agent-versions/latest')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '1.2.3', downloadUrl: '/dl', checksum: 'a'.repeat(64) }));
      } else if (req.url === '/health') {
        // The bug's trigger: the web app answers apex /health with its 404 page.
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body>404</body></html>');
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const { port } = proxy.address() as AddressInfo;
    try {
      const { code, output } = await runScript(['--server', `http://127.0.0.1:${port}`, '--token', 'tok']);
      expect(output).toContain('Breeze server is reachable');
      expect(output).not.toContain('Cannot reach the Breeze');
      // Proof it got past the pre-flight: it fails later at the binary download.
      expect(code).not.toBe(0);
      expect(output).toContain('Failed to');
    } finally {
      proxy.close();
    }
  });

  it('reports an HTTP error from the metadata endpoint distinctly from no-response', async () => {
    // A proxy that forwards /api/* to a backend that errors (or a path that 5xxs)
    // must produce the API-specific message — not the "no response" network one.
    const errsrv = createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    });
    await new Promise<void>((resolve) => errsrv.listen(0, '127.0.0.1', resolve));
    const { port } = errsrv.address() as AddressInfo;
    try {
      const { code, output } = await runScript(['--server', `http://127.0.0.1:${port}`, '--token', 'tok']);
      expect(code).not.toBe(0);
      expect(output).toContain('Cannot reach the Breeze API');
      expect(output).toContain('(HTTP 500)');
      expect(output).not.toContain('no response');
    } finally {
      errsrv.close();
    }
  });

  it('rejects a non-Breeze 200 responder that lacks the version field', async () => {
    // A proxy/auth-gateway answering the probe with 200 + non-HTML JSON that
    // isn't Breeze metadata must not be reported as "reachable" (the negative
    // not-HTML guard alone would pass it; the positive version check catches it).
    const wrong = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'blocked' }));
    });
    await new Promise<void>((resolve) => wrong.listen(0, '127.0.0.1', resolve));
    const { port } = wrong.address() as AddressInfo;
    try {
      const { code, output } = await runScript(['--server', `http://127.0.0.1:${port}`, '--token', 'tok']);
      expect(code).not.toBe(0);
      expect(output).not.toContain('Breeze server is reachable');
      expect(output).toContain('unexpected response');
    } finally {
      wrong.close();
    }
  });
});
