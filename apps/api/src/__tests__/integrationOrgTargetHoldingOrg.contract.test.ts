/**
 * CONTRACT TEST — integration mappings and connections never target a
 * holding org.
 *
 * These routes bind an external tenant, customer, site or account to a Breeze
 * organization the caller names. For partner callers the holding org is
 * already out of reach (it is never in accessibleOrgIds and canAccessOrg is
 * false for it); `canAccessOrg` is true for system scope, so each handler (or
 * the service it calls) must also refuse a holding org itself — by reading
 * the target org's type (`isUnassignedPoolOrgType`) or with `isHoldingOrg`.
 *
 * Source-level, two parts:
 *   - ORG_TARGET_WRITERS: a hand list (it includes services and routes whose
 *     org comes through a helper the discovery below cannot see);
 *   - discovery: every route file that takes an org id from the request
 *     (body/query/param, resolveScopedOrgId) AND writes a config-shaped table
 *     (connection, integration, mapping, provider, SSO, tenant, link,
 *     credential, webhook, mailbox, channel, config). Each must carry a guard or
 *     be in DISCOVERED_EXEMPT with a reason; the discovered count is pinned.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const SRC = resolve(import.meta.dirname, '..');
const GUARD = /\b(?:isHoldingOrg|isUnassignedPoolOrgType|isHiddenOrgType)\(/;

const strip = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

/** file -> the route(s) it guards. */
const ORG_TARGET_WRITERS: Record<string, string> = {
  'routes/huntress.ts': 'POST /huntress/organizations/map',
  'routes/sentinelOne.ts': 'POST /s1/organizations/map',
  'services/pax8SyncService.ts': 'POST /pax8/companies/map (mapPax8Company)',
  'routes/unifi/index.ts': 'PUT /unifi/mappings (the site\'s org)',
  'services/backupProviders/mapping.ts': 'PUT /backup/providers/customers/:id/mapping (remapCustomer) and sync-time auto-mapping',
  'services/edrProviders/mapping.ts': 'PUT /edr/tenants/:id/mapping (remapEdrTenant) and sync-time auto-mapping',
  'routes/psa.ts': 'POST /psa/connections (organization-owned)',
  'routes/clientAi/admin.ts': 'PUT /client-ai/admin/orgs/:orgId/tenant-mapping',
  'routes/m365.ts': 'POST /m365/connection',
  'routes/m365CustomerGraphRead.ts': 'POST /m365/connections/customer-graph-read/consent',
  'routes/m365CustomerGraphActions.ts': 'POST /m365/customer-graph-actions/connections/consent',
  'routes/c2c/connections.ts': 'POST /c2c/connections',
  'routes/c2c/m365Auth.ts': 'GET /c2c/m365/consent-url',
  'routes/google.ts': 'POST /google/connection',
  'routes/dnsSecurity.ts': 'POST /dns-security/integrations',
};

describe('contract: integration mappings and connections never target a holding org', () => {
  it.each(Object.entries(ORG_TARGET_WRITERS))('%s guards %s', (file) => {
    const code = strip(readFileSync(join(SRC, file), 'utf8'));
    expect(code).toMatch(GUARD);
  });
});

const ORG_FROM_REQUEST = /resolveScopedOrgId\(|\bbody\.orgId\b|\bdata\.orgId\b|\bpayload\.orgId\b|c\.req\.query\('orgId'\)|c\.req\.param\('orgId'\)/;
const CONFIG_WRITE = /\.(?:insert|update)\(\s*([A-Za-z0-9_]+)\s*\)/g;
const CONFIG_TABLE = /connection|integration|mapping|provider|sso|tenant|link|credential|webhook|mailbox|channel|config/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Discovered files that cannot target a holding org, with the reason. */
const DISCOVERED_EXEMPT: Record<string, string> = {
  'routes/pax8.ts': 'writes only partner-level integration rows; its org mapping is guarded in services/pax8SyncService.ts',
};

/** Pinned: files the discovery finds (guarded + exempt). Update on purpose. */
const DISCOVERED_FILES = 19;

describe('contract: discovered org-targeted config writes refuse a holding org', () => {
  const discovered = walk(join(SRC, 'routes'))
    .map((full) => ({ file: relative(SRC, full).replace(/\\/g, '/'), code: strip(readFileSync(full, 'utf8')) }))
    .filter(({ code }) => ORG_FROM_REQUEST.test(code)
      && [...code.matchAll(CONFIG_WRITE)].some((m) => CONFIG_TABLE.test(m[1]!)));

  it('discovers exactly the pinned number of files', () => {
    expect(discovered.length).toBe(DISCOVERED_FILES);
  });

  it('every discovered file guards, or is exempt with a reason', () => {
    const unguarded = discovered
      .filter(({ file, code }) => !(file in DISCOVERED_EXEMPT) && !GUARD.test(code))
      .map(({ file }) => file);
    expect(unguarded).toEqual([]);
  });

  it('has no stale exemptions', () => {
    const names = discovered.map((d) => d.file);
    expect(Object.keys(DISCOVERED_EXEMPT).filter((f) => !names.includes(f))).toEqual([]);
  });
});
