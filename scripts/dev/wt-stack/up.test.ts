import { describe, it, expect } from 'vitest';
import { upStack, type UpDeps } from './up';
import { stackProcessEnv } from './compose';

// #6443 — the WebAuthn pin can only run after caddy's random port exists, and
// api must be recreated (not restarted) for it to take effect.
function recordingDeps(port = 55001, pinned = true) {
  const calls: string[] = [];
  const deps: UpDeps = {
    writeEnvStack: () => { calls.push('writeEnvStack'); },
    composeUp: () => { calls.push('composeUp'); },
    waitHealthy: (_p, services) => { calls.push(`waitHealthy:${services.join(',')}`); },
    seedDatabase: () => { calls.push('seedDatabase'); },
    publishedPort: (_p, svc) => { calls.push(`publishedPort:${svc}`); return port; },
    pinWebAuthnForStack: (_w, baseUrl, d) => {
      calls.push(`pin:${baseUrl}`);
      if (pinned) { d.recreateApi(); d.waitApiHealthy(); }
      return pinned;
    },
    recreateService: (_p, svc) => { calls.push(`recreate:${svc}`); },
    containerName: (_p, svc) => `c-${svc}`,
    writeDescriptor: () => { calls.push('writeDescriptor'); },
  };
  return { calls, deps };
}

const OPTS = { worktreePath: '/wt', project: 'p', rebuild: false, admin: { email: 'a@example.test', password: 'x' } };

describe('upStack (#6443)', () => {
  it('pins WebAuthn after caddy publishes its port, recreates api, then writes the descriptor', () => {
    const { calls, deps } = recordingDeps();
    const d = upStack(OPTS, deps);
    expect(calls).toEqual([
      'writeEnvStack',
      'composeUp',
      'waitHealthy:postgres,redis,api,web,portal,caddy',
      'seedDatabase',
      'publishedPort:caddy',
      'pin:http://localhost:55001',
      'recreate:api',
      'waitHealthy:api',
      'writeDescriptor',
    ]);
    expect(d.baseUrl).toBe('http://localhost:55001');
  });

  it('skips the api recreate when the stack was already pinned to that port', () => {
    const { calls, deps } = recordingDeps(55001, false);
    upStack(OPTS, deps);
    expect(calls).not.toContain('recreate:api');
    expect(calls.at(-1)).toBe('writeDescriptor');
  });
});

describe('stackProcessEnv (#6443)', () => {
  it('drops exported WEBAUTHN_* so .env.stack wins over the shell', () => {
    const env = stackProcessEnv({ WEBAUTHN_ORIGIN: 'https://shell.invalid', WEBAUTHN_RP_ID: 'shell.invalid', PATH: '/bin' });
    expect(env).toEqual({ PATH: '/bin' });
  });
});
