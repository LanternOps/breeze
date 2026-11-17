import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Portal registration W8 (#11385, plan D3): two identity facts, named apart.
 *
 *  - `portalUserHasIdentitySql()` — ANY `portal_user_identities` row, disabled
 *    or not. "Identity-managed / the (issuer, subject) is reserved": invites,
 *    bulk invite and the identity-managed refusals.
 *  - `portalUserHasUsableIdentitySql()` — an ENABLED row (`disabled_at IS
 *    NULL`). "Has a working credential": msp_reactivate, the sso_only stranded
 *    list and hash clear (and, in Task 3, the account rule).
 *
 * Picking the wrong one is silent: an "any" where "usable" is meant keeps a
 * leaver's account active (or clears the hash of an account that can no longer
 * sign in); a "usable" where "any" is meant lets an invite target a
 * directory-managed account. So every call site in apps/api/src and ee/ is
 * classified here, keyed `file#anchor` (the enclosing function or route), with
 * the fact it must call and a one-line reason. A new call site fails until it
 * is classified; a moved or removed one fails as stale.
 *
 * Also pinned (D1): disabling keeps `portal_users.entra_*`, so no production
 * path may FIND an account through those legacy columns — only refuse on them
 * or report drift.
 */
type Fact = 'any' | 'usable';

const CALL_SITES: Record<string, { fact: Fact; reason: string }> = {
  'apps/api/src/routes/orgPortalUsers.ts#getOrgScopedPortalUser': {
    fact: 'any', reason: 'hasExternalIdentity: identity-managed refusal of every invite writer (msp_invite / resend / sso invite)',
  },
  'apps/api/src/routes/orgPortalUsers.ts#getOrgScopedPortalUser#2': {
    fact: 'usable', reason: 'hasUsableExternalIdentity: msp_reactivate needs a usable credential, else invited (spec §5.1) or, identity-managed, refused',
  },
  'apps/api/src/routes/orgPortalUsers.ts#POST /organizations/:id/portal-users/invite': {
    fact: 'any', reason: 'invite to an existing address: an identity-managed account is never invited',
  },
  'apps/api/src/routes/orgPortalUsers.ts#POST /organizations/:id/portal-users/bulk-invite': {
    fact: 'any', reason: 'bulk invite candidates: never a directory-managed account, disabled identity or not',
  },
  'apps/api/src/routes/orgPortalUsers.ts#POST /organizations/:id/portal-users/bulk-invite#2': {
    fact: 'any', reason: 'bulk invite facts for isBulkInviteEligible (same rule as the WHERE)',
  },
  'apps/api/src/routes/portal/capabilityTokens.ts#validatePortalCapability': {
    fact: 'any', reason: 'password invite / reset consumption: an identity-managed account never takes a password credential',
  },
  'apps/api/src/services/contacts/portalInvite.ts#bindContactLoginForInvite': {
    fact: 'any', reason: 'contact invite reuse plans msp_invite: identity-managed accounts are already-has-access',
  },
  'apps/api/src/services/portalAccessRequests.ts#grantBrowserAccess': {
    fact: 'any', reason: 'access_request_approve facts: the writer never reads identity facts beyond identity-managed',
  },
  'apps/api/src/services/portalOidc/accountResolution.ts#lockAccount': {
    fact: 'any', reason: 'SSO writers (sso_invite_accept, sso_instant_grant) read no credential fact; the disabled identity is refused by assertIdentityUsable',
  },
  'apps/api/src/services/portalSsoOnly.ts#strandedWhere': {
    fact: 'usable', reason: 'stranded = no working SSO credential; an account whose only identity is disabled is stranded',
  },
  'apps/api/src/services/portalSsoOnly.ts#clearableWhere': {
    fact: 'usable', reason: 'a hash is cleared only when a usable identity replaces it, never on an account whose only identity is disabled',
  },
};

/**
 * Production files that reference the legacy `portal_users.entra_*` columns,
 * each only to WRITE them (the W3 D4 fence), REFUSE on them, or REPORT drift —
 * never to find the account a sign-in becomes.
 */
const LEGACY_ENTRA_COLUMN_USERS: Record<string, string> = {
  'apps/api/src/services/portalUserIdentities.ts': 'writer fence on link; legacy pre-check refuses (conflict); drift report only',
  'apps/api/src/services/portalOidc/signInProviders.ts': 'legacyKeyHeld: refuses an invite before consumption (identity_conflict)',
  'apps/api/src/services/portalDirectory/identityDisable.ts': 'OD3 remove: the W3 D4 fence clears the removed identity\'s legacy columns (WHERE matches them); never finds an account',
};

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SCAN_ROOTS = [join(REPO_ROOT, 'apps', 'api', 'src'), join(REPO_ROOT, 'ee')];
const CALL = /\b(portalUserHasIdentitySql|portalUserHasUsableIdentitySql)\s*\(/g;
const ANCHOR = /(?:\bfunction\s+(\w+))|(?:\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>)|(?:\.(get|post|patch|put|delete)\(\s*'(\/[^']*)')/g;

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

function anchorAt(code: string, index: number): string {
  let anchor = '<module>';
  ANCHOR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR.exec(code)) !== null && m.index < index) {
    anchor = m[1] ?? m[2] ?? `${m[3]!.toUpperCase()} ${m[4]}`;
  }
  return anchor;
}

function sourceFiles(): Map<string, string> {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(root, files);
  const out = new Map<string, string>();
  for (const file of files) out.set(relative(REPO_ROOT, file).split('\\').join('/'), stripComments(readFileSync(file, 'utf8')));
  return out;
}

/** Every call site as `file#anchor[#n]` → the fact it calls. */
function callSites(files: Map<string, string>): Map<string, Fact> {
  const sites = new Map<string, Fact>();
  for (const [file, code] of files) {
    CALL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL.exec(code)) !== null) {
      // The definitions themselves are not call sites.
      if (/function\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
      const base = `${file}#${anchorAt(code, m.index)}`;
      let key = base;
      for (let n = 2; sites.has(key); n++) key = `${base}#${n}`;
      sites.set(key, m[1] === 'portalUserHasUsableIdentitySql' ? 'usable' : 'any');
    }
  }
  return sites;
}

describe('portal identity facts: every call site is classified any | usable (W8 D3)', () => {
  const files = sourceFiles();
  const sites = callSites(files);

  it('finds both facts (the scan is not vacuous)', () => {
    expect([...sites.values()]).toContain('any');
    expect([...sites.values()]).toContain('usable');
    expect(sites.size).toBeGreaterThanOrEqual(10);
  });

  it('every portalUserHasIdentitySql / portalUserHasUsableIdentitySql call site is classified', () => {
    const unclassified = [...sites.keys()].filter((k) => !(k in CALL_SITES)).sort();
    expect(unclassified, `classify each in src/__tests__/portalIdentityFacts.contract.test.ts:\n${unclassified.join('\n')}`).toEqual([]);

    const wrongFact = [...sites.entries()]
      .filter(([k, fact]) => CALL_SITES[k] !== undefined && CALL_SITES[k]!.fact !== fact)
      .map(([k, fact]) => `${k}: calls ${fact}, classified ${CALL_SITES[k]!.fact}`);
    expect(wrongFact, 'the call does not match its classified fact').toEqual([]);

    for (const [k, c] of Object.entries(CALL_SITES)) expect(c.reason.length, k).toBeGreaterThan(10);
  });

  it('the classification map has no stale entries', () => {
    const stale = Object.keys(CALL_SITES).filter((k) => !sites.has(k));
    expect(stale, 'these call sites moved or are gone; update CALL_SITES').toEqual([]);
  });

  it('the anchor scanner names functions, arrow functions and routes (not vacuous)', () => {
    const code = [
      'function alpha() { a(); }',
      'const beta = async (x: string) => { b(); };',
      "routes.post('/things/:id', async (c) => { c.get('auth'); c2(); });",
    ].join('\n');
    expect(anchorAt(code, code.indexOf('a()'))).toBe('alpha');
    expect(anchorAt(code, code.indexOf('b()'))).toBe('beta');
    expect(anchorAt(code, code.indexOf('c2()'))).toBe('POST /things/:id');
  });

  it('no production auth path reads portal_users.entra_oid (D1: a disabled identity keeps those columns)', () => {
    const legacyRead = /\bportalUsers\.(entraOid|entraTenantId)\b|\bpu\.entra_(oid|tenant_id)\b|"portal_users"\."entra_(oid|tenant_id)"|\bportal_users\.entra_(oid|tenant_id)\b/;
    const readers = [...files.entries()]
      .filter(([, code]) => legacyRead.test(code))
      .map(([file]) => file)
      // The schema declares the columns; it reads nothing.
      .filter((file) => !file.startsWith('apps/api/src/db/schema/'))
      .sort();
    expect(readers).toEqual(Object.keys(LEGACY_ENTRA_COLUMN_USERS).sort());
  });
});
