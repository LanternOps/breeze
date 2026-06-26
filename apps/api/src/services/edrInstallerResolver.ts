import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { huntressIntegrations, huntressOrgMappings } from '../db/schema';
import { decryptForColumn } from './secretCrypto';
import type { BuiltinProvider } from './builtinDeploymentPackages';

export interface ResolvedInstaller {
  downloadUrl: string | null;
  silentInstallArgs: string | null;
}
export type EdrResolveError = { error: string };

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

export async function resolveEdrInstaller(params: {
  provider: BuiltinProvider;
  orgId: string;
  downloadUrlTemplate: string | null;
  silentInstallArgsTemplate: string | null;
}): Promise<ResolvedInstaller | EdrResolveError> {
  if (params.provider === 'huntress') return resolveHuntress(params);
  return resolveSentinelOne(params); // implemented in Task 11
}

async function resolveHuntress(params: {
  orgId: string;
  downloadUrlTemplate: string | null;
  silentInstallArgsTemplate: string | null;
}): Promise<ResolvedInstaller | EdrResolveError> {
  // System context: the integration row is partner-axis and unreadable under
  // an org-scoped request context (partner read needs system context).
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
          accountId: huntressIntegrations.accountId,
          apiKeyEncrypted: huntressIntegrations.apiKeyEncrypted,
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

  // The Huntress Account Key used in the download URL and /ACCT_KEY.
  // VERIFICATION (spec open question 4b): confirm whether accountId is the deploy
  // account key, or whether a dedicated decrypted field must be used here.
  const acctKey = ctx.integration.accountId;
  const orgKey = ctx.mapping.orgKey;
  if (!acctKey) return { error: 'Huntress account key not available; reconnect the integration' };
  if (!orgKey) return { error: 'Huntress org key not synced; run Sync in Integrations' };

  return substituteHuntress(
    { downloadUrlTemplate: params.downloadUrlTemplate, silentInstallArgsTemplate: params.silentInstallArgsTemplate },
    { acctKey, orgKey },
  );
}

// Placeholder until Task 11 implements it.
async function resolveSentinelOne(_params: {
  orgId: string;
  downloadUrlTemplate: string | null;
  silentInstallArgsTemplate: string | null;
}): Promise<ResolvedInstaller | EdrResolveError> {
  return { error: 'SentinelOne resolution not yet implemented' };
}
