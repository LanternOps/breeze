import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCAN_NOISE, scanApiEnvNames } from '../system/connections/envScan';
import { INTERNAL_ENV_VARS } from '../system/connections/internalEnvVars';
import { CONNECTION_REGISTRY } from '../system/connections/registry';
import {
  COMPOSE_BASELINE_UNMAPPED,
  COMPOSE_INTENTIONALLY_UNMAPPED,
  type ComposeFileKey,
} from './envReadComposeCoverage.baseline';

/**
 * Why this test exists (#7470)
 * ----------------------------
 * envComposeParity.test.ts starts from the names in `.env.example`. A variable
 * the API reads that nobody ever wrote into `.env.example` is invisible to it —
 * which is how AUDIT_ANCHOR_SIGNING_KEY shipped: read by
 * services/auditAnchorSigning.ts, listed on System → Connections, and reachable
 * on no compose install, so every audit anchor was written unsigned and setting
 * the key in `.env` did nothing.
 *
 * This guard starts from the other end: the names the API source actually
 * reads, taken from the same scan as the System → Connections coverage ratchet
 * (system/connections/envScan.ts). That ratchet already forces every name into
 * one of two buckets, and this test gives each bucket its compose contract:
 *
 *   - CONNECTION_REGISTRY — operator-facing by definition (it is what the
 *     System page shows an operator). Must reach the api container.
 *   - INTERNAL_ENV_VARS — tuning knobs, test hooks, rollout flags; each entry
 *     there is already a reasoned "not operator-facing" allow-list line, so
 *     these need no compose mapping — UNLESS the operator environment
 *     reference (apps/docs/.../deploy/environment.mdx) documents the name.
 *     Documenting a knob there tells an operator "set this in .env and it
 *     takes effect", so a documented internal name must reach the container
 *     too (AUDIT_CHAIN_VERIFY_* was documented and unmapped).
 *
 * "Reaches the api container" means: a key of the `x-api-env` anchor, or of
 * the `api` service's own `environment:` block, in the compose file. Both
 * compose files are checked independently.
 *
 * An operator-facing name that is not mapped must be on one of two lists in
 * envReadComposeCoverage.baseline.ts:
 *   - COMPOSE_INTENTIONALLY_UNMAPPED — correct as it is, with a reason.
 *   - COMPOSE_BASELINE_UNMAPPED — the gaps that predate this guard. Frozen:
 *     NEVER add a name to it. Map the var or justify it in the intentional
 *     list instead. Mapping a baseline var fails the "stale" test below until
 *     the entry is removed, so the list can only shrink.
 *
 * Mapping costs nothing when the operator leaves the var unset, PROVIDED the
 * consumer treats an empty string as unset — the `${VAR:-}` form passes ''.
 * Check the consumer before mapping (e.g. `Number(process.env.X ?? 10)` reads
 * '' as 0, not 10).
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const COMPOSE_FILES: Readonly<Record<ComposeFileKey, string>> = {
  root: 'docker-compose.yml',
  prod: 'deploy/docker-compose.prod.yml',
};

/**
 * Keys of the `x-api-env` anchor plus the `api` service's own `environment:`
 * block. Indentation-based, matching how both compose files are laid out
 * (anchor keys at 2 spaces, service environment keys at 6).
 */
export function apiContainerEnvKeys(composeText: string): Set<string> {
  const keys = new Set<string>();
  let section: 'none' | 'anchor' | 'api' | 'apiEnv' = 'none';
  for (const line of composeText.split('\n')) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^x-api-env:/.test(line)) { section = 'anchor'; continue; }
    if (/^ {2}api:\s*$/.test(line)) { section = 'api'; continue; }
    if (section === 'anchor' && /^\S/.test(line)) section = 'none';
    if ((section === 'api' || section === 'apiEnv') && /^ {0,2}\S/.test(line)) section = 'none';
    if (section === 'apiEnv' && /^ {4}\S/.test(line)) section = 'api';
    if (section === 'api' && /^ {4}environment:\s*$/.test(line)) { section = 'apiEnv'; continue; }
    const match = section === 'anchor' ? /^ {2}([A-Z][A-Z0-9_]*):/.exec(line)
      : section === 'apiEnv' ? /^ {6}([A-Z][A-Z0-9_]*):/.exec(line)
        : null;
    if (match?.[1]) keys.add(match[1]);
  }
  return keys;
}

/** Every `UPPER_SNAKE` name the operator environment reference puts in backticks. */
export function documentedEnvNames(mdx: string): Set<string> {
  return new Set([...mdx.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]!));
}

const scanned = new Set([...scanApiEnvNames()].filter((name) => !(name in SCAN_NOISE)));
const registryNames = new Set(CONNECTION_REGISTRY.flatMap((entry) => entry.vars.map((v) => v.name)));
const documented = documentedEnvNames(
  readFileSync(path.join(REPO_ROOT, 'apps/docs/src/content/docs/deploy/environment.mdx'), 'utf8'),
);

/** Names that must reach the api container, with why. */
function operatorFacingNames(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of [...scanned].sort()) {
    if (registryNames.has(name)) out.set(name, 'System → Connections registry');
    else if (name in INTERNAL_ENV_VARS && documented.has(name)) out.set(name, 'documented in deploy/environment.mdx');
  }
  return out;
}

const operatorFacing = operatorFacingNames();

describe('apiContainerEnvKeys parser', () => {
  const sample = [
    'x-api-env: &api-env',
    '  # a comment',
    '  FROM_ANCHOR: ${FROM_ANCHOR:-}',
    '',
    'services:',
    '  api:',
    '    image: x',
    '    environment:',
    '      <<: *api-env',
    '      FROM_API_SERVICE: ${A:-all}',
    '    volumes:',
    '      - NOT_A_KEY:/x',
    '  worker:',
    '    environment:',
    '      FROM_WORKER: worker',
  ].join('\n');

  it('collects anchor keys and api-service keys, and nothing from other services', () => {
    expect([...apiContainerEnvKeys(sample)].sort()).toEqual(['FROM_ANCHOR', 'FROM_API_SERVICE']);
  });

  it.each(Object.entries(COMPOSE_FILES))('finds a realistic key set in %s (guards a broken parse)', (_key, file) => {
    const keys = apiContainerEnvKeys(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    expect(keys.size).toBeGreaterThan(200);
    for (const name of ['DATABASE_URL', 'JWT_SECRET', 'REDIS_PASSWORD_FILE', 'BREEZE_ROLE']) {
      expect(keys.has(name), `${file} should map ${name}`).toBe(true);
    }
  });
});

describe('operator-facing inventory', () => {
  it('is non-trivial and covers both sources (guards a broken scan or docs parse)', () => {
    const reasons = [...operatorFacing.values()];
    expect(reasons.filter((r) => r.startsWith('System')).length).toBeGreaterThan(100);
    expect(reasons.filter((r) => r.startsWith('documented')).length).toBeGreaterThan(50);
  });
});

describe.each(Object.entries(COMPOSE_FILES) as Array<[ComposeFileKey, string]>)(
  'every operator-facing env read reaches the api container: %s',
  (key, file) => {
    const keys = apiContainerEnvKeys(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    const intentional = COMPOSE_INTENTIONALLY_UNMAPPED[key];
    const baseline = new Set(COMPOSE_BASELINE_UNMAPPED[key]);

    it('maps it, or lists it as intentionally unmapped with a reason', () => {
      const unmapped = [...operatorFacing]
        .filter(([name]) => !keys.has(name) && !(name in intentional) && !baseline.has(name))
        .map(([name, why]) => `${name}  (${why})`);
      expect(
        unmapped,
        `The API reads these, they are operator-facing, and ${file} never passes them to the api container — ` +
          `setting them in .env is a silent no-op. Map each in the x-api-env block as \`NAME: \${NAME:-}\` ` +
          `(after checking the consumer reads '' as unset), or add it to COMPOSE_INTENTIONALLY_UNMAPPED.${key} ` +
          `in envReadComposeCoverage.baseline.ts with a reason. Do NOT add it to COMPOSE_BASELINE_UNMAPPED.\n  ` +
          unmapped.join('\n  '),
      ).toEqual([]);
    });

    it('has no stale exemptions (each still names an unmapped operator-facing read)', () => {
      const stale = [...Object.keys(intentional), ...baseline].filter(
        (name) => keys.has(name) || !operatorFacing.has(name),
      );
      expect(
        stale,
        `Mapped in ${file} now, or no longer an operator-facing read — remove from envReadComposeCoverage.baseline.ts:\n  ` +
          stale.join('\n  '),
      ).toEqual([]);
    });

    it('lists no name on both exemption lists, and every intentional entry has a reason', () => {
      expect(Object.keys(intentional).filter((name) => baseline.has(name))).toEqual([]);
      for (const [name, reason] of Object.entries(intentional)) {
        expect(reason.trim().length, name).toBeGreaterThan(10);
      }
    });
  },
);

/**
 * The variables #7470 is about, pinned by name so they cannot slip back onto
 * an exemption list: anchor signing, the anchor kill switch, the nightly
 * verifier knobs, the dedicated audit-retention credential, and the offline
 * command-queue deadlines.
 */
describe('#7470 regression: audit + command-queue variables reach the api container', () => {
  const PINNED = [
    'AUDIT_ANCHOR_SIGNING_KEY',
    'AUDIT_CHAIN_ANCHOR_ENABLED',
    'AUDIT_CHAIN_VERIFY_ENABLED',
    'AUDIT_CHAIN_VERIFY_MODE',
    'AUDIT_CHAIN_VERIFY_RESCAN_SLICES',
    'AUDIT_ADMIN_DATABASE_URL',
    'DEVICE_COMMAND_QUEUE_TTL_HOURS',
    'DEVICE_COMMAND_QUEUE_SHORT_TTL_HOURS',
    'DEVICE_COMMAND_QUEUE_POWER_STATE_TTL_HOURS',
  ] as const;

  it.each(PINNED)('%s is read by the API', (name) => {
    expect(scanned.has(name)).toBe(true);
  });

  it.each(PINNED)('%s is documented in deploy/environment.mdx', (name) => {
    expect(documented.has(name)).toBe(true);
  });

  for (const [key, file] of Object.entries(COMPOSE_FILES) as Array<[ComposeFileKey, string]>) {
    const keys = apiContainerEnvKeys(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    it.each(PINNED)(`%s is mapped in ${file}`, (name) => {
      expect(keys.has(name)).toBe(true);
      expect(name in COMPOSE_INTENTIONALLY_UNMAPPED[key]).toBe(false);
    });
  }
});
