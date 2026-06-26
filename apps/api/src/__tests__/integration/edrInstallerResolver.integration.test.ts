/**
 * Integration test for the deploy-time EDR key resolver (Tasks 5-6).
 *
 * Proves resolveEdrInstaller reads the partner-scoped huntress_integrations row
 * and the org's huntress_org_mappings row IN A SYSTEM DB CONTEXT and substitutes
 * the real per-org account key + org key into the installer URL / silent args.
 * Also covers the fail-clean branches (unmapped org, disconnected integration).
 *
 * Runs as breeze_app so the system-context cross-axis read is genuinely exercised.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { huntressIntegrations, huntressOrgMappings, s1Integrations, s1OrgMappings } from '../../db/schema';
import { encryptSecret } from '../../services/secretCrypto';
import { resolveEdrInstaller } from '../../services/edrInstallerResolver';
import { createPartner, createOrganization } from './db-utils';

const URL_TPL = 'https://update.huntress.io/download/{huntress_acct_key}/HuntressInstaller.exe';
const ARGS_TPL = '/ACCT_KEY="{huntress_acct_key}" /ORG_KEY="{huntress_org_key}" /S';

async function seedHuntress(opts: { acctKey: string | null; orgKey: string; orgId: string; partnerId: string; isActive: boolean }) {
  return withSystemDbAccessContext(async () => {
    const [integration] = await db.insert(huntressIntegrations).values({
      partnerId: opts.partnerId,
      name: 'Test Huntress',
      apiKeyEncrypted: encryptSecret('dummy-api-key', { aad: 'huntress_integrations.api_key_encrypted' })!,
      accountId: 'huntress-account-id-123',
      accountKeyEncrypted: opts.acctKey
        ? encryptSecret(opts.acctKey, { aad: 'huntress_integrations.account_key_encrypted' })!
        : null,
      isActive: opts.isActive,
    }).returning({ id: huntressIntegrations.id });

    await db.insert(huntressOrgMappings).values({
      integrationId: integration!.id,
      partnerId: opts.partnerId,
      huntressOrgId: `h-org-${Date.now()}`,
      huntressOrgKey: opts.orgKey,
      orgId: opts.orgId,
    });
    return integration!.id;
  });
}

describe('resolveEdrInstaller — Huntress (db)', () => {
  it('injects the real per-org account key + org key', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await seedHuntress({ acctKey: 'ACCT-DEPLOY-KEY', orgKey: 'org-key-xyz', orgId: org.id, partnerId: partner.id, isActive: true });

    const result = await resolveEdrInstaller({
      provider: 'huntress',
      orgId: org.id,
      downloadUrlTemplate: URL_TPL,
      silentInstallArgsTemplate: ARGS_TPL,
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.downloadUrl).toBe('https://update.huntress.io/download/ACCT-DEPLOY-KEY/HuntressInstaller.exe');
    expect(result.silentInstallArgs).toBe('/ACCT_KEY="ACCT-DEPLOY-KEY" /ORG_KEY="org-key-xyz" /S');
  });

  it('fails clean when the org is not mapped', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    // No huntress mapping seeded for this org.
    const result = await resolveEdrInstaller({
      provider: 'huntress',
      orgId: org.id,
      downloadUrlTemplate: URL_TPL,
      silentInstallArgsTemplate: ARGS_TPL,
    });
    expect(result).toEqual({ error: 'Organization not mapped to Huntress' });
  });

  it('fails clean when the integration is disconnected', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await seedHuntress({ acctKey: 'ACCT', orgKey: 'ok', orgId: org.id, partnerId: partner.id, isActive: false });

    const result = await resolveEdrInstaller({
      provider: 'huntress',
      orgId: org.id,
      downloadUrlTemplate: URL_TPL,
      silentInstallArgsTemplate: ARGS_TPL,
    });
    expect(result).toEqual({ error: 'Huntress integration is disconnected' });
  });
});

const S1_ARGS_TPL = 'SITE_TOKEN={s1_site_token} /q /NORESTART';

async function seedS1(opts: { siteToken: string | null; orgId: string; partnerId: string; isActive: boolean }) {
  return withSystemDbAccessContext(async () => {
    const [integration] = await db.insert(s1Integrations).values({
      partnerId: opts.partnerId,
      name: 'Test S1',
      apiTokenEncrypted: encryptSecret('dummy-token', { aad: 's1_integrations.api_token_encrypted' })!,
      managementUrl: 'https://example.sentinelone.net',
      isActive: opts.isActive,
    }).returning({ id: s1Integrations.id });

    await db.insert(s1OrgMappings).values({
      integrationId: integration!.id,
      partnerId: opts.partnerId,
      s1SiteId: `site-${Date.now()}`,
      orgId: opts.orgId,
      registrationToken: opts.siteToken
        ? encryptSecret(opts.siteToken, { aad: 's1_org_mappings.registration_token' })!
        : null,
    });
    return integration!.id;
  });
}

describe('resolveEdrInstaller — SentinelOne (db)', () => {
  it('decrypts and injects the per-org site token', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await seedS1({ siteToken: 'eyJ-site-token', orgId: org.id, partnerId: partner.id, isActive: true });

    const result = await resolveEdrInstaller({
      provider: 'sentinelone',
      orgId: org.id,
      downloadUrlTemplate: null,
      silentInstallArgsTemplate: S1_ARGS_TPL,
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.silentInstallArgs).toBe('SITE_TOKEN=eyJ-site-token /q /NORESTART');
  });

  it('fails clean when the site token has not been synced', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await seedS1({ siteToken: null, orgId: org.id, partnerId: partner.id, isActive: true });

    const result = await resolveEdrInstaller({
      provider: 'sentinelone',
      orgId: org.id,
      downloadUrlTemplate: null,
      silentInstallArgsTemplate: S1_ARGS_TPL,
    });
    expect(result).toEqual({ error: 'SentinelOne site token not synced — run Sync in Integrations' });
  });

  it('fails clean when the org is not mapped', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const result = await resolveEdrInstaller({
      provider: 'sentinelone',
      orgId: org.id,
      downloadUrlTemplate: null,
      silentInstallArgsTemplate: S1_ARGS_TPL,
    });
    expect(result).toEqual({ error: 'Organization not mapped to SentinelOne' });
  });
});
