import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '../security.txt';

// One module instance for the whole file, on purpose: the route must read the
// container environment on EVERY request. A test that re-imported the module
// per case (or used `vi.stubEnv`, which also fills `import.meta.env`) would stay
// green against a build-time read that is dead in the Docker image.
const KEYS = ['PUBLIC_ABUSE_CONTACT', 'PUBLIC_SECURITY_CONTACT', 'PUBLIC_SECURITY_POLICY_URL'] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) {
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
}

describe('GET /.well-known/security.txt', () => {
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    setEnv({});
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is 404 when no contact is configured, so self-hosted installs publish nothing by default', async () => {
    const res = await GET({} as never);
    expect(res.status).toBe(404);
  });

  it('reads the environment at request time: the same module flips from 404 to 200 when contacts appear', async () => {
    expect((await GET({} as never)).status).toBe(404);
    setEnv({
      PUBLIC_ABUSE_CONTACT: 'abuse@example.com',
      PUBLIC_SECURITY_CONTACT: 'security@example.com',
      PUBLIC_SECURITY_POLICY_URL: 'https://example.com/trust',
    });
    const res = await GET({} as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const body = await res.text();
    expect(body).toContain('Contact: mailto:security@example.com\n');
    expect(body).toContain('Contact: mailto:abuse@example.com\n');
    expect(body).toContain('Policy: https://example.com/trust\n');
    const expires = body.match(/^Expires: (\S+)$/m)?.[1];
    expect(expires).toBeDefined();
    const days = (new Date(expires!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(30);
    expect(days).toBeLessThan(365); // RFC 9116 §2.5.5: under a year
    setEnv({});
    expect((await GET({} as never)).status).toBe(404);
  });

  it('no server-side contact reader uses import.meta.env (Vite would freeze it into the image at build)', () => {
    const root = resolve(__dirname, '../../..');
    for (const rel of [
      'pages/.well-known/security.txt.ts',
      'layouts/AuthLayout.astro',
      'layouts/AuthShellBranded.astro',
      'lib/securityContact.ts',
    ]) {
      const src = readFileSync(resolve(root, rel), 'utf8');
      // Allow the word only inside comments that explain the rule.
      const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(code, rel).not.toContain('import.meta.env');
    }
  });
});
