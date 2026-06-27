import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { huntressIntegrations, huntressOrgMappings, s1Integrations, s1OrgMappings } from '../db/schema';
import { decryptForColumn } from './secretCrypto';
import type { BuiltinProvider } from './builtinDeploymentPackages';

export interface ResolvedInstaller {
  downloadUrl: string | null;
  silentInstallArgs: string | null;
}
/** Failure outcome. No HTTP `status` — callers always map this to a 200 body with `status:'failed'`. */
export type EdrResolveError = { error: string };

/** Decrypt a column-bound secret, returning null on either empty input or a
 *  decryption failure (corrupt blob, wrong key, missing AAD). decryptForColumn
 *  THROWS on a malformed value, so we convert that into the resolver's graceful
 *  `{ error }` contract rather than letting it become a 500. */
function tryDecryptColumn(table: string, column: string, value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return decryptForColumn(table, column, value);
  } catch {
    return null;
  }
}

/** Pure substitution - kept separate so it is unit-testable without a DB. */
export function substituteHuntress(
  templates: { downloadUrlTemplate: string | null; silentInstallArgsTemplate: string | null },
  keys: { acctKey: string; orgKey: string },
): ResolvedInstaller {
  const apply = (s: string | null) =>
    s == null ? null : s
      .replaceAll('{huntress_acct_key}', keys.acctKey)
      .replaceAll('{huntress_org_key}', keys.orgKey);
  return {
    downloadUrl: apply(templates.downloadUrlTemplate),
    silentInstallArgs: apply(templates.silentInstallArgsTemplate),
  };
}

export function substituteS1(
  templates: { downloadUrlTemplate: string | null; silentInstallArgsTemplate: string | null },
  keys: { siteToken: string },
): ResolvedInstaller {
  const apply = (s: string | null) =>
    s == null ? null : s.replaceAll('{s1_site_token}', keys.siteToken);
  return {
    downloadUrl: apply(templates.downloadUrlTemplate),
    silentInstallArgs: apply(templates.silentInstallArgsTemplate),
  };
}

export async function resolveEdrInstaller(params: {
  provider: BuiltinProvider;
  orgId: string;
  downloadUrlTemplate: string | null;
  silentInstallArgsTemplate: string | null;
}): Promise<ResolvedInstaller | EdrResolveError> {
  if (params.provider === 'huntress') return resolveHuntress(params);
  return resolveSentinelOne(params);
}

async function resolveHuntress(params: {
  orgId: string;
  downloadUrlTemplate: string | null;
  silentInstallArgsTemplate: string | null;
}): Promise<ResolvedInstaller | EdrResolveError> {
  // System context: both huntress_org_mappings and huntress_integrations are
  // partner-axis (Shape 3); under an org-scoped request context both reads
  // silently return zero rows. Read under system context, keyed off the trusted
  // authenticated orgId the caller passed.
  const ctx = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [mapping] = await db
        .select({
          orgKey: huntressOrgMappings.huntressOrgKey,
          integrationId: huntressOrgMappings.integrationId,
        })
        .from(huntressOrgMappings)
        .where(eq(huntressOrgMappings.orgId, params.orgId))
        .limit(1);
      if (!mapping) return { kind: 'unmapped' as const };

      const [integration] = await db
        .select({
          accountKeyEncrypted: huntressIntegrations.accountKeyEncrypted,
          isActive: huntressIntegrations.isActive,
        })
        .from(huntressIntegrations)
        .where(eq(huntressIntegrations.id, mapping.integrationId))
        .limit(1);
      if (!integration || !integration.isActive) return { kind: 'inactive' as const };

      return { kind: 'ok' as const, mapping, integration };
    })
  );

  if (ctx.kind === 'unmapped') return { error: 'Organization not mapped to Huntress' };
  if (ctx.kind === 'inactive') return { error: 'Huntress integration is disconnected' };

  // The Huntress deployment Account Key (used in the installer URL and /ACCT_KEY) is
  // a dedicated secret distinct from the API account_id; it is captured on the
  // integration form and stored encrypted.
  const orgKey = ctx.mapping.orgKey;
  if (!orgKey) return { error: 'Huntress org key not synced; run Sync in Integrations' };
  if (!ctx.integration.accountKeyEncrypted) {
    return { error: 'Huntress account key not configured — add it in the Huntress integration settings' };
  }
  const acctKey = tryDecryptColumn('huntress_integrations', 'account_key_encrypted', ctx.integration.accountKeyEncrypted);
  if (!acctKey) {
    return { error: 'Huntress account key could not be decrypted — re-enter it in the integration settings' };
  }

  const resolved = substituteHuntress(
    { downloadUrlTemplate: params.downloadUrlTemplate, silentInstallArgsTemplate: params.silentInstallArgsTemplate },
    { acctKey, orgKey },
  );
  // A built-in Huntress package must always yield a concrete download URL — never
  // fall through to dispatching an un-substituted template.
  if (!resolved.downloadUrl) return { error: 'Huntress installer URL is unavailable for this package' };
  return resolved;
}

async function resolveSentinelOne(params: {
  orgId: string;
  downloadUrlTemplate: string | null;
  silentInstallArgsTemplate: string | null;
}): Promise<ResolvedInstaller | EdrResolveError> {
  // System context: s1_org_mappings and s1_integrations are partner-axis (Shape 3),
  // unreadable under an org-scoped request. Keyed off the trusted authenticated orgId.
  const ctx = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [mapping] = await db
        .select({
          tokenEncrypted: s1OrgMappings.registrationToken,
          integrationId: s1OrgMappings.integrationId,
        })
        .from(s1OrgMappings)
        .where(eq(s1OrgMappings.orgId, params.orgId))
        .limit(1);
      if (!mapping) return { kind: 'unmapped' as const };

      const [integration] = await db
        .select({ isActive: s1Integrations.isActive })
        .from(s1Integrations)
        .where(eq(s1Integrations.id, mapping.integrationId))
        .limit(1);
      if (!integration || !integration.isActive) return { kind: 'inactive' as const };

      return { kind: 'ok' as const, tokenEncrypted: mapping.tokenEncrypted };
    })
  );

  if (ctx.kind === 'unmapped') return { error: 'Organization not mapped to SentinelOne' };
  if (ctx.kind === 'inactive') return { error: 'SentinelOne integration is disconnected' };

  if (!ctx.tokenEncrypted) {
    return { error: 'SentinelOne site token not synced — run Sync in Integrations' };
  }
  const siteToken = tryDecryptColumn('s1_org_mappings', 'registration_token', ctx.tokenEncrypted);
  if (!siteToken) {
    return { error: 'SentinelOne site token could not be decrypted — reconnect the integration' };
  }

  return substituteS1(
    { downloadUrlTemplate: params.downloadUrlTemplate, silentInstallArgsTemplate: params.silentInstallArgsTemplate },
    { siteToken },
  );
}
