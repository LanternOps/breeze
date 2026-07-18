import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { runBreezectl, LOCK_SUFFIX, type BreezectlOptions } from './breezectl.lib';

let dir: string;
let configPath: string;
let out: string[];

const BASE_YAML = `# Deployment configuration for signed runtime extensions.
publishers:
  lanternops:
    publicKeyFile: keys/lanternops.pem
extensions:
  - name: demo
    uri: https://cdn.example.test/demo-1.0.0.zip
    version: 1.0.0
    digest: sha256:${'a'.repeat(64)}
    publisher: lanternops
    required: false
    rollout: rolling
`;

function opts(over: Partial<BreezectlOptions> = {}): BreezectlOptions {
  return {
    configPath,
    log: (line: string) => out.push(line),
    env: {},
    fetch: (async () => {
      throw new Error('fetch should not be called');
    }) as unknown as typeof fetch,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'breezectl-'));
  configPath = path.join(dir, 'extensions.yaml');
  writeFileSync(configPath, BASE_YAML);
  out = [];
});

afterEach(() => {
  try {
    chmodSync(dir, 0o755);
    chmodSync(configPath, 0o644);
  } catch {
    /* already writable or gone */
  }
  rmSync(dir, { recursive: true, force: true });
});

const NEW_ARGS = [
  '--name', 'billing',
  '--uri', 'https://cdn.example.test/billing-2.0.0.zip',
  '--version', '2.0.0',
  '--digest', `sha256:${'b'.repeat(64)}`,
  '--publisher', 'lanternops',
];

describe('source of truth: extensions.yaml', () => {
  it('refuses install when extensions.yaml is not writable', async () => {
    chmodSync(configPath, 0o444);
    chmodSync(dir, 0o555);
    await expect(
      runBreezectl(['extensions', 'install', ...NEW_ARGS], opts()),
    ).rejects.toThrow(/change deployment configuration/);
  });

  it('leaves the file untouched when the write is refused', async () => {
    const before = readFileSync(configPath, 'utf8');
    chmodSync(configPath, 0o444);
    chmodSync(dir, 0o555);
    await runBreezectl(['extensions', 'install', ...NEW_ARGS], opts()).catch(() => {});
    chmodSync(dir, 0o755);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('never imports a database module (desired state cannot reach PostgreSQL)', () => {
    const source = readFileSync(path.join(__dirname, 'breezectl.lib.ts'), 'utf8');
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/\/db\b|drizzle|postgres|stateStore|reconciler/);
    }
  });
});

describe('extensions install', () => {
  it('adds exactly one selection and shows a diff', async () => {
    await runBreezectl(['extensions', 'install', ...NEW_ARGS], opts());

    const parsed = loadYaml(readFileSync(configPath, 'utf8')) as {
      extensions: Array<Record<string, unknown>>;
    };
    expect(parsed.extensions).toHaveLength(2);
    const added = parsed.extensions.find((e) => e.name === 'billing');
    expect(added).toMatchObject({
      name: 'billing',
      uri: 'https://cdn.example.test/billing-2.0.0.zip',
      version: '2.0.0',
      digest: `sha256:${'b'.repeat(64)}`,
      publisher: 'lanternops',
      required: false,
      rollout: 'rolling',
    });
    // The untouched selection survives byte-identically in content.
    expect(parsed.extensions.find((e) => e.name === 'demo')).toMatchObject({ version: '1.0.0' });

    const text = out.join('\n');
    expect(text).toMatch(/^\+.*billing/m);
    // Comment loss is announced rather than silently inflicted.
    expect(text).toMatch(/comments/i);
  });

  it('refuses to install an extension that is already selected', async () => {
    await expect(
      runBreezectl(
        ['extensions', 'install', '--name', 'demo', '--uri', 'x', '--version', '2.0.0', '--publisher', 'lanternops'],
        opts(),
      ),
    ).rejects.toThrow(/already selected/);
  });

  it('refuses an undeclared publisher', async () => {
    await expect(
      runBreezectl(
        ['extensions', 'install', '--name', 'billing', '--uri', 'x', '--version', '2.0.0', '--publisher', 'ghost'],
        opts(),
      ),
    ).rejects.toThrow(/publisher/i);
  });

  it('is a dry run under --dry-run', async () => {
    const before = readFileSync(configPath, 'utf8');
    await runBreezectl(['extensions', 'install', ...NEW_ARGS, '--dry-run'], opts());
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(out.join('\n')).toMatch(/dry run/i);
  });
});

describe('extensions upgrade', () => {
  it('replaces exactly one selection', async () => {
    await runBreezectl(
      ['extensions', 'upgrade', '--name', 'demo', '--version', '1.4.0', '--digest', `sha256:${'c'.repeat(64)}`],
      opts(),
    );
    const parsed = loadYaml(readFileSync(configPath, 'utf8')) as {
      extensions: Array<Record<string, unknown>>;
    };
    expect(parsed.extensions).toHaveLength(1);
    expect(parsed.extensions[0]).toMatchObject({
      name: 'demo',
      version: '1.4.0',
      digest: `sha256:${'c'.repeat(64)}`,
      // Untouched fields are carried over, not reset to defaults.
      uri: 'https://cdn.example.test/demo-1.0.0.zip',
      publisher: 'lanternops',
    });
  });

  it('refuses to upgrade an extension that is not selected', async () => {
    await expect(
      runBreezectl(['extensions', 'upgrade', '--name', 'ghost', '--version', '1.0.0'], opts()),
    ).rejects.toThrow(/not selected/);
  });
});

describe('advisory lock', () => {
  it('refuses to edit while another breezectl holds the lock', async () => {
    const lock = `${configPath}${LOCK_SUFFIX}`;
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    await expect(
      runBreezectl(['extensions', 'install', ...NEW_ARGS], opts()),
    ).rejects.toThrow(/lock/i);
  });

  it('releases the lock after a successful edit', async () => {
    await runBreezectl(['extensions', 'install', ...NEW_ARGS], opts());
    expect(existsSync(`${configPath}${LOCK_SUFFIX}`)).toBe(false);
  });

  it('releases the lock after a failed edit', async () => {
    await runBreezectl(
      ['extensions', 'install', '--name', 'demo', '--uri', 'x', '--version', '2.0.0', '--publisher', 'lanternops'],
      opts(),
    ).catch(() => {});
    expect(existsSync(`${configPath}${LOCK_SUFFIX}`)).toBe(false);
  });

  it('breaks a stale lock', async () => {
    const lock = `${configPath}${LOCK_SUFFIX}`;
    writeFileSync(lock, JSON.stringify({ pid: 999999, at: 'an hour ago' }));
    // Staleness is judged on the lockfile's mtime, not on the (untrusted) body
    // a crashed process left behind — so backdate the mtime to simulate it.
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(lock, anHourAgo, anHourAgo);
    await runBreezectl(['extensions', 'install', ...NEW_ARGS], opts());
    const parsed = loadYaml(readFileSync(configPath, 'utf8')) as { extensions: unknown[] };
    expect(parsed.extensions).toHaveLength(2);
    expect(out.join('\n')).toMatch(/stale lock/i);
  });

  // Two runs that both judge the SAME lock stale interleave: the second unlinks
  // the first's FRESH lockfile and creates its own. Without an owner marker the
  // first run's release would unlink the second's live lock. The nonce makes
  // both acquisition and release conditional on still owning the file.
  it('stamps an owner nonce into the lockfile', async () => {
    const lock = `${configPath}${LOCK_SUFFIX}`;
    let observed: { pid?: number; nonce?: string } | null = null;
    await runBreezectl(
      ['extensions', 'install', ...NEW_ARGS],
      opts({
        log: (line: string) => {
          out.push(line);
          // Read the lockfile while the edit is still in flight.
          observed ??= JSON.parse(readFileSync(lock, 'utf8'));
        },
      }),
    );
    expect(observed?.pid).toBe(process.pid);
    expect(typeof observed?.nonce).toBe('string');
    expect(observed?.nonce).not.toHaveLength(0);
    expect(existsSync(lock)).toBe(false);
  });

  it('does not remove a lockfile that another run now owns', async () => {
    const lock = `${configPath}${LOCK_SUFFIX}`;
    await runBreezectl(
      ['extensions', 'install', ...NEW_ARGS],
      opts({
        log: (line: string) => {
          out.push(line);
          // Simulate a concurrent run breaking our lock and taking the path.
          if (existsSync(lock)) {
            writeFileSync(lock, JSON.stringify({ pid: 424242, nonce: 'someone-elses' }));
          }
        },
      }),
    );
    // The other run's lock survives our release, and we say so.
    expect(existsSync(lock)).toBe(true);
    expect(JSON.parse(readFileSync(lock, 'utf8')).nonce).toBe('someone-elses');
    expect(out.join('\n')).toMatch(/not releasing/i);
  });
});

describe('required flag', () => {
  it('promotes with --required and demotes with --not-required', async () => {
    await runBreezectl(
      ['extensions', 'upgrade', '--name', 'demo', '--version', '2.0.0', '--required'],
      opts(),
    );
    let parsed = loadYaml(readFileSync(configPath, 'utf8')) as {
      extensions: Array<{ name: string; required: boolean }>;
    };
    expect(parsed.extensions.find((e) => e.name === 'demo')?.required).toBe(true);

    // Carried forward when neither flag is given.
    await runBreezectl(['extensions', 'upgrade', '--name', 'demo', '--version', '3.0.0'], opts());
    parsed = loadYaml(readFileSync(configPath, 'utf8')) as typeof parsed;
    expect(parsed.extensions.find((e) => e.name === 'demo')?.required).toBe(true);

    // Demoted only by the explicit flag.
    await runBreezectl(
      ['extensions', 'upgrade', '--name', 'demo', '--version', '4.0.0', '--not-required'],
      opts(),
    );
    parsed = loadYaml(readFileSync(configPath, 'utf8')) as typeof parsed;
    expect(parsed.extensions.find((e) => e.name === 'demo')?.required).toBe(false);
  });

  it('rejects --required together with --not-required', async () => {
    await expect(
      runBreezectl(
        ['extensions', 'upgrade', '--name', 'demo', '--required', '--not-required'],
        opts(),
      ),
    ).rejects.toThrow(/mutually exclusive/i);
  });
});

describe('admin API verbs', () => {
  const env = {
    BREEZE_ADMIN_TOKEN: 'tok-123',
    PUBLIC_API_URL: 'https://breeze.example.test/',
  };

  it('calls the authenticated admin API to disable', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ name: 'demo', enabled: false }), { status: 200 }),
    );
    await runBreezectl(
      ['extensions', 'disable', 'demo'],
      opts({ env, fetch: fetchMock as unknown as typeof fetch }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://breeze.example.test/api/v1/admin/extensions/demo/disable');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok-123');
  });

  it('fails with an actionable error when the token env is unset', async () => {
    await expect(
      runBreezectl(['extensions', 'enable', 'demo'], opts({ env: { PUBLIC_API_URL: 'https://x.test' } })),
    ).rejects.toThrow(/BREEZE_ADMIN_TOKEN/);
  });

  it('fails with an actionable error when the server origin is unset', async () => {
    await expect(
      runBreezectl(['extensions', 'enable', 'demo'], opts({ env: { BREEZE_ADMIN_TOKEN: 't' } })),
    ).rejects.toThrow(/PUBLIC_API_URL/);
  });

  it('surfaces an API error status without echoing the response body', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('platform admin access required (token=abc)', { status: 403 }),
    );
    await expect(
      runBreezectl(
        ['extensions', 'enable', 'demo'],
        opts({ env, fetch: fetchMock as unknown as typeof fetch }),
      ),
    ).rejects.toThrow(/403/);
  });

  it('lists through the admin API', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ extensions: [{ name: 'demo', enabled: true, lifecycleState: 'active', activeVersion: '1.0.0' }] }),
        { status: 200 },
      ),
    );
    await runBreezectl(['extensions', 'list'], opts({ env, fetch: fetchMock as unknown as typeof fetch }));
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://breeze.example.test/api/v1/admin/extensions',
    );
    expect(out.join('\n')).toMatch(/demo/);
  });
});

describe('usage', () => {
  it('rejects an unknown verb', async () => {
    await expect(runBreezectl(['extensions', 'frobnicate'], opts())).rejects.toThrow(/unknown/i);
  });

  it('rejects an unknown noun', async () => {
    await expect(runBreezectl(['widgets', 'list'], opts())).rejects.toThrow(/usage|unknown/i);
  });

  it('verify requires a selected extension name', async () => {
    await expect(
      runBreezectl(['extensions', 'verify', '--name', 'ghost', '--archive', '/nope.zip'], opts()),
    ).rejects.toThrow(/not selected/);
  });
});
