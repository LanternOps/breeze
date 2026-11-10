import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Portal registration W2 (#11379), spec §6 invariant 10: every writer of
 * `portal_users.status` / `browser_access` follows the transition table in
 * services/portalAccountState.ts.
 *
 * This census finds every non-test source file under apps/api/src and ee/
 * that INSERTs or UPDATEs `portal_users` (Drizzle or raw SQL, comments
 * stripped) and requires it to be classified:
 *   - 'state-module' — it writes state, so it must import portalAccountState
 *     AND call one of its planners (planPortalAccountTransition /
 *     initialPortalAccountState);
 *   - 'no-state'     — it never writes `status` or `browserAccess`: no
 *     `status:` / `browserAccess:` key may appear in any `.set({…})` or
 *     `.values({…})` block, whatever its value (a heuristic over the source,
 *     not a per-write-site proof).
 *
 * A new writer fails here until it is classified. A writer that stops writing
 * fails as stale. Generic SQL that never names the table (org merge repoint,
 * tenant cascade) is not a state writer and is not matched.
 */
type Classification =
  | { kind: 'state-module' }
  | { kind: 'no-state'; reason: string };

const PORTAL_USER_WRITERS: Record<string, Classification> = {
  'apps/api/src/routes/orgPortalUsers.ts': { kind: 'state-module' },
  'apps/api/src/routes/portal/auth.ts': { kind: 'state-module' },
  'apps/api/src/services/clientAiExchange.ts': { kind: 'state-module' },
  // Portal registration W1 (#11378) contact invite: create + reuse, both
  // planned by the state module and epoch-guarded like orgPortalUsers.ts.
  'apps/api/src/services/contacts/portalInvite.ts': { kind: 'state-module' },
  // Portal registration W3 (#11380): approving an access request creates an
  // account (initialPortalAccountState) or grants browser access to an add-in
  // login (planPortalAccountTransition, epoch-guarded).
  'apps/api/src/services/portalAccessRequests.ts': { kind: 'state-module' },
  'apps/api/src/routes/portal/profile.ts': { kind: 'no-state', reason: 'name / receiveNotifications / passwordHash only' },
  // Portal registration W4 (#11381, plan D7): a tenant proof that displaces
  // another org's mapping bumps auth_epoch (+ updated_at) on that org's
  // accounts with an Entra identity in the tenant. Never status / browserAccess.
  'apps/api/src/services/portalEntraTenantProof.ts': { kind: 'no-state', reason: 'authEpoch / updatedAt bump on displacement only' },
  // Portal registration W4 (#11381) Microsoft sign-in: the identity-only
  // account writer shared by W3 approval and instant mode
  // (initialPortalAccountState), and OIDC account resolution (invite
  // activation, instant browser grant — planPortalAccountTransition,
  // epoch-guarded).
  'apps/api/src/services/portalIdentityAccounts.ts': { kind: 'state-module' },
  'apps/api/src/services/portalOidc/accountResolution.ts': { kind: 'state-module' },
  // W4 linkPortalUserIdentity: the W3 D4 writer fence (entra_tenant_id /
  // entra_oid) and the D12 password_hash clear when linking under sso_only.
  'apps/api/src/services/portalUserIdentities.ts': { kind: 'no-state', reason: 'entraTenantId / entraOid / passwordHash / updatedAt on identity link only' },
  // W4 (#11381) plan D12: an acknowledged sso_only save clears the hash and
  // bumps the epoch of the flipped orgs' accounts that have an identity.
  'apps/api/src/services/portalSsoOnly.ts': { kind: 'no-state', reason: 'passwordHash / authEpoch / updatedAt on an sso_only save only' },
};

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SCAN_ROOTS = [join(REPO_ROOT, 'apps', 'api', 'src'), join(REPO_ROOT, 'ee')];
const WRITE_PATTERNS = [
  /\.insert\(\s*portalUsers\s*\)/,
  /\.update\(\s*portalUsers\s*\)/,
  /INSERT\s+INTO\s+(?:public\.)?portal_users\b/i,
  /UPDATE\s+(?:public\.)?portal_users\b/i,
];
const STATE_IMPORT = /from\s+['"][./]*(?:services\/)?portalAccountState['"]/;
const STATE_PLANNER_CALL = /\b(planPortalAccountTransition|initialPortalAccountState)\s*\(/;

/**
 * The argument text of every `.set(…)` / `.values(…)` call (balanced-paren
 * scan; good enough for a census over our own source).
 */
function writeBlocks(code: string): string[] {
  const blocks: string[] = [];
  const opener = /\.(?:set|values)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(code)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
    }
    blocks.push(code.slice(start, i - 1));
  }
  return blocks;
}

/** A `status` / `browserAccess` key in a write block — literal, variable or shorthand. */
export function writesStateKey(code: string): boolean {
  return writeBlocks(code).some((block) => /(?:^|[{,\s])(status|browserAccess)\s*[:,}]/.test(block));
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // ee/ may be absent in a stripped checkout
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry) && !/\.(test|spec)\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
}

/** Strips block and line comments (good enough for a census; strings are left alone). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function writerFiles(): Map<string, string> {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(root, files);
  const writers = new Map<string, string>();
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (WRITE_PATTERNS.some((p) => p.test(code))) {
      writers.set(relative(REPO_ROOT, file).split('\\').join('/'), code);
    }
  }
  return writers;
}

describe('portal_users writers are classified against the account state machine (W2 inv. 10)', () => {
  const writers = writerFiles();

  it('finds the known writers (the walk is not vacuous)', () => {
    expect([...writers.keys()]).toContain('apps/api/src/routes/orgPortalUsers.ts');
    expect([...writers.keys()]).toContain('apps/api/src/services/clientAiExchange.ts');
  });

  it('every portal_users writer is classified and state writers use portalAccountState', () => {
    const unclassified = [...writers.keys()].filter((file) => !(file in PORTAL_USER_WRITERS)).sort();
    expect(
      unclassified,
      `classify each in src/__tests__/portalAccountWriters.contract.test.ts:\n${unclassified.join('\n')}`,
    ).toEqual([]);

    const missingImport = Object.entries(PORTAL_USER_WRITERS)
      .filter(([file, c]) => c.kind === 'state-module' && writers.has(file)
        && !(STATE_IMPORT.test(writers.get(file)!) && STATE_PLANNER_CALL.test(writers.get(file)!)))
      .map(([file]) => file);
    expect(missingImport, 'these write portal_users state but do not import AND call services/portalAccountState').toEqual([]);

    const noStateViolations = Object.entries(PORTAL_USER_WRITERS)
      .filter(([file, c]) => c.kind === 'no-state' && writers.has(file) && writesStateKey(writers.get(file)!))
      .map(([file]) => file);
    expect(noStateViolations, 'these are classified no-state but write a status/browserAccess key').toEqual([]);
  });

  it('the no-state detector catches literal, variable and shorthand state writes (not vacuous)', () => {
    expect(writesStateKey(`db.update(portalUsers).set({ name, status: 'active' })`)).toBe(true);
    expect(writesStateKey(`db.update(portalUsers).set({ status: next, updatedAt })`)).toBe(true);
    expect(writesStateKey(`db.update(portalUsers).set({ status })`)).toBe(true);
    expect(writesStateKey(`db.insert(portalUsers).values({ orgId, browserAccess: grant })`)).toBe(true);
    expect(writesStateKey(`db.update(portalUsers).set({ passwordHash, authEpoch: sql\`x + 1\` })`)).toBe(false);
    expect(writesStateKey(`return c.json({ status: 'ok' })`)).toBe(false);
  });

  it('the classification map has no stale entries', () => {
    const stale = Object.keys(PORTAL_USER_WRITERS).filter((file) => !writers.has(file));
    expect(stale, 'these no longer write portal_users; remove them from PORTAL_USER_WRITERS').toEqual([]);
  });
});
