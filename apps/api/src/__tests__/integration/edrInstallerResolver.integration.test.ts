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
import { huntressIntegrations, huntressOrgMappings } from '../../db/schema';
import { encryptSecret } from '../../services/secretCrypto';
import { resolveEdrInstaller } from '../../services/edrInstallerResolver';
import { createPartner, createOrganization } from './db-utils';

const URL_TPL = 'https://update.huntress.io/download/{huntress_acct_key}/HuntressInstaller.exe';
const ARGS_TPL = '/ACCT_KEY="{huntress_acct_key}" /ORG_KEY="{huntress_org_key}" /S';

async function seedHuntress(opts: { acctKey: string; orgKey: string; orgId: string; partnerId: string; isActive: boolean }) {
  return withSystemDbAccessContext(async () => {
    const [integration] = await db.insert(huntressIntegrations).values({
      partnerId: opts.partnerId,
      name: 'Test Huntress',
      apiKeyEncrypted: encryptSecret('dummy-api-key', { aad: 'huntress_integrations.api_key_encrypted' })!,
      accountId: opts.acctKey,
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
