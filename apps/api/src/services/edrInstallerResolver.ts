import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { huntressIntegrations, huntressOrgMappings, s1Integrations, s1OrgMappings } from '../db/schema';
import { decryptForColumn } from './secretCrypto';
import { getBuiltinPackage, installArgsCarryPlaceholders, type BuiltinProvider } from './builtinDeploymentPackages';
import { validateVendorUrl } from './edrProviders/guardedFetch';
import { openInstallerMaterial } from './edrProviders/installerMaterial';
import { selectInstallerTenant } from './edrProviders/installerTenant';
import {
  EDR_PROVIDER_LABELS,
  isEdrInstallerProviderKey,
  type EdrInstallerProviderKey,
} from './edrProviders/providerKeys';
import { getEdrProvider } from './edrProviders/registry';
import type { EdrInstallerFileType } from './edrProviders/types';

export interface ResolvedInstaller {
  downloadUrl: string | null;
  silentInstallArgs: string | null;
  /** Absent = keep the version row's value. */
  fileName?: string;
  fileType?: EdrInstallerFileType;
  /** Absent = keep the version's checksum; null = the vendor publishes none (dispatch sends no checksum). */
  checksum?: string | null;
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
  if (isEdrInstallerProviderKey(params.provider)) return resolveFrameworkInstaller(params.provider, params.orgId);
  // Exhaustive (#6960): a provider without its own branch is refused, never
  // handed to another vendor's key lookup.
  switch (params.provider) {
    case 'huntress':
      return resolveHuntress(params);
    case 'sentinelone':
      return resolveSentinelOne(params);
    default: {
      const unsupported: never = params.provider;
      return { error: `Unsupported integration provider: ${String(unsupported)}` };
    }
  }
}

/**
 * An installer for a framework provider, built from material the sync worker
 * sealed on the tenant row. No vendor HTTP here: dispatch can run inside the
 * install-remediation worker's transaction (#1105). Refusals are operator copy
 * and never quote the link.
 */
/** A framework install always overrides all three: absent would fall back to the version row's values. */
type FrameworkResolvedInstaller = ResolvedInstaller & Required<Pick<ResolvedInstaller, 'fileName' | 'fileType' | 'checksum'>> & {
  downloadUrl: string;
};

async function resolveFrameworkInstaller(
  provider: EdrInstallerProviderKey,
  orgId: string,
): Promise<FrameworkResolvedInstaller | EdrResolveError> {
  const label = EDR_PROVIDER_LABELS[provider];
  const pkg = getBuiltinPackage(provider);
  if (!pkg.released) return { error: `${label} installs are not available yet` };

  const selection = await selectInstallerTenant(provider, orgId);
  switch (selection.kind) {
    case 'ok':
      break;
    case 'not_mapped':
      return { error: `Organization not mapped to ${label}` };
    case 'ambiguous':
      return { error: `Organization maps to ${selection.count} ${label} tenants — map it to one` };
    case 'inactive':
      return { error: `${label} integration is disconnected` };
    case 'material_missing':
      return { error: `${label} installer link not fetched yet — run Sync in Integrations` };
    case 'material_expired':
      return { error: `${label} installer link has expired — run Sync in Integrations` };
    default: {
      const unhandled: never = selection;
      return { error: `Unsupported installer selection: ${String(unhandled)}` };
    }
  }

  const unreadableMessage = `${label} installer link could not be read — reconnect the integration`;
  // Ids and a reason code only: never the material.
  const unreadable = (reason: string): EdrResolveError => {
    console.warn(`[edr:installer] refused stored ${provider} material for tenant ${selection.tenantId} (${reason})`);
    return { error: unreadableMessage };
  };
  const envelope = openInstallerMaterial(selection.tenantId, selection.sealedMaterial);
  if (!envelope) return unreadable('unopenable');
  if (envelope.provider !== provider) return unreadable('provider_mismatch');

  const adapter = getEdrProvider(provider);
  const spec = adapter.buildInstaller?.(envelope.data, pkg.installerPlatform);
  if (!spec) return unreadable('no_builder');
  if ('error' in spec) {
    return spec.error === 'platform_unsupported'
      ? { error: `${label} installer is not available for this platform` }
      : unreadable(spec.error);
  }
  // The agent refuses a file whose extension is not `.<fileType>`; refuse here, before a download.
  if (!spec.fileName.toLowerCase().endsWith(`.${spec.fileType}`)) return unreadable('extension_mismatch');
  // Again at dispatch: the allowlist can narrow after the material was stored.
  if (!validateVendorUrl(spec.downloadUrl, adapter.installerHostAllowlist ?? []).ok) return unreadable('url_rejected');

  return {
    downloadUrl: spec.downloadUrl,
    silentInstallArgs: spec.silentInstallArgs,
    fileName: spec.fileName,
    fileType: spec.fileType,
    checksum: spec.checksum,
  };
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
  // The site token reaches the installer ONLY through this placeholder. Args
  // without it (the generic msiexec default a Versions-tab upload gets) would
  // install SentinelOne unregistered on every target, so refuse (#6960).
  if (!installArgsCarryPlaceholders('sentinelone', params.silentInstallArgsTemplate)) {
    return { error: 'SentinelOne install arguments must include SITE_TOKEN={s1_site_token} — edit the installer version' };
  }

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
