import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createVercelSandboxBackend } from '../../services/workspace/vercelSandboxBackend';
import type { SandboxBackend, SandboxHandle } from '../../services/workspace/sandboxBackend';

/**
 * Nightly real-Vercel evidence suite (spec §12, §10 "the nightly suite's
 * blocked-egress assertions are the evidence").
 *
 * Everything here is an assertion about the VENDOR, not about Breeze code:
 * that deny-all really blocks DNS, raw IPv4, IPv6 and ordinary HTTPS; that
 * `persistent: false` plus `delete({ deleteOrphanSnapshots: true })` really
 * leaves nothing behind; that the provider deadline really fires; that usage
 * really comes back. Breeze's own logic is covered by the contract suite.
 *
 * Double-gated so it can never run by accident: WORKSPACE_E2E=1 AND all three
 * Vercel credentials.
 */
const ENABLED = process.env.WORKSPACE_E2E === '1'
  && Boolean(process.env.VERCEL_SANDBOX_TOKEN)
  && Boolean(process.env.VERCEL_TEAM_ID)
  && Boolean(process.env.VERCEL_PROJECT_ID);

const SH = 'sh';
const MIB = 1024 * 1024;

/** Run a one-line shell script by writing it and executing it by path. */
async function runScript(
  backend: SandboxBackend,
  handle: SandboxHandle,
  name: string,
  script: string,
  timeoutMs = 45_000,
) {
  await backend.writeFiles(handle, [{ path: `/work/${name}`, bytes: Buffer.from(`${script}\n`) }]);
  return backend.exec(handle, [SH, `/work/${name}`], { timeoutMs, maxStdoutBytes: 64 * 1024 });
}

describe.skipIf(!ENABLED)('workspace vercel e2e (nightly)', () => {
  let backend: SandboxBackend;
  let handle: SandboxHandle;

  beforeAll(async () => {
    backend = createVercelSandboxBackend();
    handle = await backend.create({
      runId: '55555555-5555-4555-8555-555555555555',
      orgId: '66666666-6666-4666-8666-666666666666',
      region: 'eu',
      cpu: 1,
      memoryMb: 2048,
      deadlineSeconds: 600,
      image: 'breeze-analysis@nightly',
    });
  });

  afterAll(async () => {
    try {
      await backend.destroy(handle);
    } catch {
      /* the cleanup case asserts this separately */
    }
  });

  it('landed in the requested EU region', () => {
    expect(handle.region).toBe('eu');
    expect(handle.backend).toBe('vercel');
  });

  it('cannot resolve DNS', async () => {
    const res = await runScript(
      backend,
      handle,
      'egress-dns.sh',
      'getent hosts example.com || nslookup example.com || echo DNS_BLOCKED',
    );
    expect(`${res.stdout}${res.stderr}`).toContain('DNS_BLOCKED');
  });

  it('cannot reach a public host over HTTPS', async () => {
    const res = await runScript(
      backend,
      handle,
      'egress-https.sh',
      'curl -sS --max-time 20 https://example.com >/dev/null && echo REACHED || echo HTTPS_BLOCKED',
    );
    expect(`${res.stdout}${res.stderr}`).toContain('HTTPS_BLOCKED');
    expect(res.stdout.toString()).not.toContain('REACHED');
  });

  it('cannot reach a raw IPv4 address (no DNS required)', async () => {
    const res = await runScript(
      backend,
      handle,
      'egress-ipv4.sh',
      'curl -sS --max-time 20 http://1.1.1.1/ >/dev/null && echo REACHED || echo IPV4_BLOCKED',
    );
    expect(`${res.stdout}${res.stderr}`).toContain('IPV4_BLOCKED');
    expect(res.stdout.toString()).not.toContain('REACHED');
  });

  it('cannot reach a raw IPv6 address', async () => {
    const res = await runScript(
      backend,
      handle,
      'egress-ipv6.sh',
      'curl -sS -6 --max-time 20 "http://[2606:4700:4700::1111]/" >/dev/null && echo REACHED || echo IPV6_BLOCKED',
    );
    expect(`${res.stdout}${res.stderr}`).toContain('IPV6_BLOCKED');
    expect(res.stdout.toString()).not.toContain('REACHED');
  });

  it('carries no Breeze credential in its environment', async () => {
    const res = await runScript(backend, handle, 'env-dump.sh', 'env | sort');
    const dump = res.stdout.toString();
    for (const secret of ['DATABASE_URL', 'JWT_SECRET', 'APP_ENCRYPTION_KEY', 'VERCEL_SANDBOX_TOKEN', 'ANTHROPIC']) {
      expect(dump).not.toContain(secret);
    }
  });

  it('stages a 256 MiB input successfully', async () => {
    await backend.writeFiles(
      handle,
      [{ path: '/work/in/big.bin', bytes: Buffer.alloc(256 * MIB, 0x42) }],
      { maxTotalBytes: 512 * MIB },
    );
    const listed = await backend.listFiles(handle, '/work/in');
    expect(listed.find((f) => f.path === '/work/in/big.bin')?.bytes).toBe(256 * MIB);
  }, 300_000);

  it('refuses an over-cap stage before touching the vendor', async () => {
    await expect(
      backend.writeFiles(
        handle,
        [{ path: '/work/in/over.bin', bytes: Buffer.alloc(8 * MIB) }],
        { maxTotalBytes: 1 * MIB },
      ),
    ).rejects.toMatchObject({ code: 'file_too_large' });
  });

  it('reports usage after destroy and it is non-zero', async () => {
    await runScript(
      backend,
      handle,
      'burn.sh',
      'i=0; while [ $i -lt 2000000 ]; do i=$((i+1)); done; echo burned',
    );
    await backend.destroy(handle);
    const usage = await backend.usage(handle);
    expect(usage.cpuMs).toBeGreaterThan(0);
    expect(usage.wallMs).toBeGreaterThan(0);
    expect(usage.memAllocatedMb).toBe(2048);
  });

  it('leaves nothing behind after destroy — no live sandbox, no snapshot', async () => {
    const { Sandbox, Snapshot } = await import('@vercel/sandbox');
    const credentials = {
      token: process.env.VERCEL_SANDBOX_TOKEN as string,
      teamId: process.env.VERCEL_TEAM_ID as string,
      projectId: process.env.VERCEL_PROJECT_ID as string,
    };
    // Vercel rejects `namePrefix` unless `sortBy` is `name` (400 "Invalid
    // request: `namePrefix` is only valid when `sortBy` is `name`") — seen on
    // the first live nightly run, 2026-09-14, once the credentials landed.
    const sandboxes = await (await Sandbox.list({ namePrefix: handle.providerRef, sortBy: 'name', ...credentials })).toArray();
    const live = sandboxes.filter((s) => s.status !== 'stopped' && s.status !== 'aborted');
    expect(live).toEqual([]);

    const snapshots = await (await Snapshot.list({ ...credentials })).toArray();
    // persistent:false plus deleteOrphanSnapshots means this run can have made
    // no snapshot at all. Assert none references our session.
    expect(snapshots.filter((s) => s.status === 'created' && s.sizeBytes > 0
      && String(s.sourceSessionId).includes(handle.providerRef))).toEqual([]);
  });

  it('fires the provider deadline on a short-lived sandbox', async () => {
    const shortLived = await backend.create({
      runId: '77777777-7777-4777-8777-777777777777',
      orgId: '88888888-8888-4888-8888-888888888888',
      region: 'eu',
      cpu: 1,
      memoryMb: 2048,
      deadlineSeconds: 60,
      image: 'breeze-analysis@nightly-deadline',
    });
    try {
      // Wait past the provider deadline, then prove the sandbox is gone rather
      // than merely idle: a further exec must fail, not succeed silently.
      await new Promise((resolve) => setTimeout(resolve, 75_000));
      await expect(
        backend.exec(shortLived, ['echo', 'still-alive'], {
          timeoutMs: 15_000,
          maxStdoutBytes: 256,
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/not_found|create_failed/) });
    } finally {
      await backend.destroy(shortLived).catch(() => undefined);
    }
  }, 180_000);
});
