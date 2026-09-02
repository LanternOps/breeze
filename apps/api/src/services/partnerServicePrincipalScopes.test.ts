import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES,
  PARTNER_SERVICE_PRINCIPAL_SCOPES,
  hasPartnerServicePrincipalScope,
  validatePartnerServicePrincipalScopes,
} from './partnerServicePrincipalScopes';

describe('partner partner-service-principal scopes', () => {
  it('accepts the exact eight supported read scopes', () => {
    expect(validatePartnerServicePrincipalScopes([...PARTNER_SERVICE_PRINCIPAL_SCOPES])).toEqual({
      ok: true,
      scopes: [...PARTNER_SERVICE_PRINCIPAL_SCOPES],
    });
  });

  it('rejects an unsupported scope', () => {
    expect(validatePartnerServicePrincipalScopes(['organizations:read', 'alerts:read'])).toEqual({
      ok: false,
      status: 400,
      error: 'Unsupported partner service principal scope: alerts:read',
      details: { supportedScopes: PARTNER_SERVICE_PRINCIPAL_SCOPES },
    });
  });

  it('rejects duplicate scopes instead of silently widening or normalizing delegation', () => {
    expect(validatePartnerServicePrincipalScopes(['devices:read', 'devices:read'])).toEqual({
      ok: false,
      status: 400,
      error: 'Partner service principal scopes must not contain duplicates',
      details: { duplicateScopes: ['devices:read'] },
    });
  });

  it('rejects an empty scope set', () => {
    expect(validatePartnerServicePrincipalScopes([])).toEqual({
      ok: false,
      status: 400,
      error: 'At least one partner service principal scope is required',
    });
  });

  it('checks delegated scopes by exact membership only', () => {
    const delegated = ['devices:read', 'inventory:read'] as const;

    expect(hasPartnerServicePrincipalScope(delegated, 'devices:read')).toBe(true);
    expect(hasPartnerServicePrincipalScope(delegated, 'organizations:read')).toBe(false);
    expect(hasPartnerServicePrincipalScope(['*'], 'devices:read')).toBe(false);
    expect(hasPartnerServicePrincipalScope(['devices'], 'devices:read')).toBe(false);
  });

  it('publishes a frozen default Weavestream delegation of exactly the eight read scopes', () => {
    // Named explicitly on purpose — NOT derived from PARTNER_SERVICE_PRINCIPAL_SCOPES.
    // Since #3243 the full scope list also contains tenancy WRITE scopes, and the
    // default delegation must never absorb a new scope implicitly: adding one
    // here has to be a deliberate human decision, because every default-scoped
    // principal inherits it.
    expect(DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES).toEqual([
      'organizations:read',
      'sites:read',
      'devices:read',
      'inventory:read',
      'configuration:read',
      'scripts:read',
      'backup-configuration:read',
      'custom-fields:read',
    ]);
    // SECURITY: enrollment-keys:write mints device-join credentials. Asserted
    // explicitly in addition to the list above so that a future edit to the
    // enumeration cannot quietly hand credential minting to every
    // default-scoped principal.
    expect(DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES).not.toContain(
      'enrollment-keys:write',
    );
    expect(Object.isFrozen(DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES)).toBe(true);
  });

  it('never includes a write scope in the default delegation', () => {
    // Provisioning writes (#3243) are opt-in at principal creation only.
    for (const scope of DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES) {
      expect(scope.endsWith(':read')).toBe(true);
    }
  });
});

/**
 * TS <-> SQL scope parity.
 *
 * `partner_service_principals.scopes` carries a CHECK backed by
 * `breeze_valid_partner_service_principal_scopes`, which enumerates the
 * allowlist a second time in SQL. That enumeration has already drifted once:
 * the write scopes (#3243) were added to `PARTNER_SERVICE_PRINCIPAL_SCOPES`
 * with no matching migration, so the database rejected every principal
 * carrying one while TypeScript and the web UI happily offered them.
 *
 * The failure mode is silent in the other direction too — a scope removed from
 * TypeScript but left in SQL stays grantable by direct database write. So this
 * asserts EXACT set equality, not containment, against whichever migration
 * most recently replaced the function (autoMigrate applies them in
 * `localeCompare` filename order, so the last match wins at runtime).
 */
describe('partner service principal scope allowlist parity with SQL', () => {
  const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');
  const FUNCTION_NAME = 'breeze_valid_partner_service_principal_scopes';

  function latestMigrationDefiningTheFunction(): { file: string; sql: string } {
    const matches = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b))
      .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf8') }))
      .filter(({ sql }) => sql.includes(`FUNCTION public.${FUNCTION_NAME}`));
    const last = matches.at(-1);
    if (!last) throw new Error(`No migration defines public.${FUNCTION_NAME}`);
    return last;
  }

  /** The `candidate_scopes <@ ARRAY[...]::text[]` allowlist, as a set. */
  function sqlAllowlist(sql: string): string[] {
    const match = /<@\s*ARRAY\[([\s\S]*?)\]::text\[\]/u.exec(sql);
    if (!match) throw new Error('Could not locate the ARRAY[...] scope allowlist in the migration');
    return [...match[1].matchAll(/'([^']+)'/gu)].map((m) => m[1]);
  }

  it('enumerates exactly PARTNER_SERVICE_PRINCIPAL_SCOPES', () => {
    const { file, sql } = latestMigrationDefiningTheFunction();
    const fromSql = sqlAllowlist(sql);
    // Sorted comparison: order is meaningless to `<@` and the two lists are
    // maintained independently, so ordering must not be the thing that fails.
    expect({ file, scopes: [...fromSql].sort() })
      .toEqual({ file, scopes: [...PARTNER_SERVICE_PRINCIPAL_SCOPES].sort() });
  });

  it('lists each scope once, since the function also rejects duplicates', () => {
    const fromSql = sqlAllowlist(latestMigrationDefiningTheFunction().sql);
    expect(fromSql).toHaveLength(new Set(fromSql).size);
  });

  it('finds a real allowlist rather than passing on an unparsed migration', () => {
    // Guards the parser itself: if the ARRAY literal is ever reformatted out of
    // recognition, the two tests above must fail loudly instead of comparing
    // two empty lists.
    expect(sqlAllowlist(latestMigrationDefiningTheFunction().sql).length).toBeGreaterThan(0);
  });
});
