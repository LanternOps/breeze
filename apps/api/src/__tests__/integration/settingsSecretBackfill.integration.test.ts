/**
 * Sealing notification-channel values stored before they were sealed on
 * write — against real Postgres, run as `breeze_app` with forced RLS (the
 * service elects system scope itself).
 *
 * Proves: every unsealed value at a settings secret path becomes ciphertext
 * that opens back to the original; nothing else in the blob changes; sealed
 * values are left byte-identical; a second run is a no-op; a save landing
 * between the read and the write is never overwritten.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { organizations, partners, sites } from '../../db/schema';
import { decryptForColumn, encryptSecret, isEncryptedSecret } from '../../services/secretCrypto';
import { encryptColumnValueForWrite } from '../../services/encryptedColumnRegistry';
import { sealUnsealedSettingsSecrets } from '../../services/settingsSecretBackfill';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';

const SLACK = 'https://hooks.slack.example/services/T000/B000/plain-secret';
const EXTRA_A = 'https://hooks.example.com/a?token=plain-a';
const EXTRA_B = 'https://hooks.example.com/b?token=plain-b';

function unsealedNotifications() {
  return {
    fromAddress: 'alerts@example.com',
    smtpPort: 587,
    slackWebhookUrl: SLACK,
    slackChannel: '#ops-alerts',
    webhooks: [EXTRA_A, EXTRA_B],
    pushoverAppToken: 'azGDORePK8gMaC0QOYAMyEEuzJnyUi',
    pushoverDefaultUser: 'uQiRzpo4DXghDmr9QzzfQu27cmVRsG',
    pushoverDefaultSound: 'pushover',
    pushoverDefaultPriority: 1,
    preferences: { critical: { email: true, slack: false } },
  };
}

async function readSettings(table: typeof partners | typeof organizations | typeof sites, id: string) {
  const [row] = await getTestDb().select({ settings: table.settings }).from(table).where(eq(table.id, id));
  return row?.settings as Record<string, any>;
}

function expectSealedTo(table: 'partners' | 'organizations' | 'sites', value: unknown, plaintext: string) {
  expect(typeof value).toBe('string');
  expect(isEncryptedSecret(value as string)).toBe(true);
  expect(decryptForColumn(table, 'settings', value as string)).toBe(plaintext);
}

describe('sealUnsealedSettingsSecrets', () => {
  it('seals every unsealed notification value and leaves the rest of the blob alone', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const otherSettings = { branding: { primaryColor: '#123456' }, eventLogs: { enabled: false } };
    await getTestDb().update(partners)
      .set({ settings: { ...otherSettings, notifications: unsealedNotifications() } })
      .where(eq(partners.id, partner.id));
    await getTestDb().update(organizations)
      .set({ settings: { notifications: { slackWebhookUrl: SLACK, webhooks: [EXTRA_A, ''] } } })
      .where(eq(organizations.id, org.id));
    await getTestDb().update(sites)
      .set({ settings: { notifications: { pushoverAppToken: 'site-token' } } })
      .where(eq(sites.id, site.id));

    const errors: string[] = [];
    const result = await sealUnsealedSettingsSecrets({ logger: { error: (m: string) => errors.push(m) } });

    expect(errors).toEqual([]);
    expect(result.partners).toEqual({ scanned: 1, sealed: 1, contended: 0, failed: 0 });
    expect(result.organizations).toEqual({ scanned: 1, sealed: 1, contended: 0, failed: 0 });
    expect(result.sites).toEqual({ scanned: 1, sealed: 1, contended: 0, failed: 0 });

    const partnerSettings = await readSettings(partners, partner.id);
    const n = partnerSettings.notifications;
    expectSealedTo('partners', n.slackWebhookUrl, SLACK);
    expectSealedTo('partners', n.pushoverAppToken, 'azGDORePK8gMaC0QOYAMyEEuzJnyUi');
    expectSealedTo('partners', n.pushoverDefaultUser, 'uQiRzpo4DXghDmr9QzzfQu27cmVRsG');
    expect(n.webhooks).toHaveLength(2);
    expectSealedTo('partners', n.webhooks[0], EXTRA_A);
    expectSealedTo('partners', n.webhooks[1], EXTRA_B);
    const { slackWebhookUrl: _s, pushoverAppToken: _t, pushoverDefaultUser: _u, webhooks: _w, ...rest } = n;
    const { slackWebhookUrl: _s2, pushoverAppToken: _t2, pushoverDefaultUser: _u2, webhooks: _w2, ...expectedRest } =
      unsealedNotifications();
    expect(rest).toEqual(expectedRest);
    expect(partnerSettings.branding).toEqual(otherSettings.branding);
    expect(partnerSettings.eventLogs).toEqual(otherSettings.eventLogs);
    expect(JSON.stringify(partnerSettings)).not.toContain('plain-');

    const orgNotifications = (await readSettings(organizations, org.id)).notifications;
    expectSealedTo('organizations', orgNotifications.slackWebhookUrl, SLACK);
    expectSealedTo('organizations', orgNotifications.webhooks[0], EXTRA_A);
    expect(orgNotifications.webhooks[1]).toBe('');

    expectSealedTo('sites', (await readSettings(sites, site.id)).notifications.pushoverAppToken, 'site-token');
  });

  it('is a no-op on a second run and leaves already-sealed values byte-identical', async () => {
    const partner = await createPartner();
    const alreadySealed = encryptColumnValueForWrite('partners', 'settings', {
      notifications: { slackWebhookUrl: SLACK, webhooks: [EXTRA_A] },
    }) as Record<string, any>;
    await getTestDb().update(partners)
      .set({ settings: { notifications: { ...alreadySealed.notifications, pushoverAppToken: 'plain-token' } } })
      .where(eq(partners.id, partner.id));

    const first = await sealUnsealedSettingsSecrets();
    expect(first.partners.sealed).toBe(1);
    const afterFirst = (await readSettings(partners, partner.id)).notifications;
    expect(afterFirst.slackWebhookUrl).toBe(alreadySealed.notifications.slackWebhookUrl);
    expect(afterFirst.webhooks).toEqual(alreadySealed.notifications.webhooks);
    expectSealedTo('partners', afterFirst.pushoverAppToken, 'plain-token');

    const second = await sealUnsealedSettingsSecrets();
    expect(second.partners).toEqual({ scanned: 0, sealed: 0, contended: 0, failed: 0 });
    expect((await readSettings(partners, partner.id)).notifications).toEqual(afterFirst);
  });

  it('never overwrites a save that lands between its read and its write', async () => {
    const partner = await createPartner();
    await getTestDb().update(partners)
      .set({ settings: { notifications: { slackWebhookUrl: SLACK, slackChannel: '#ops' } } })
      .where(eq(partners.id, partner.id));

    const concurrentValue = 'https://hooks.slack.example/services/saved-concurrently';
    let raced = false;
    const result = await sealUnsealedSettingsSecrets({
      beforeWrite: async (table, id) => {
        if (raced || table !== 'partners' || id !== partner.id) return;
        raced = true;
        await getTestDb().update(partners)
          .set({ settings: { notifications: { slackWebhookUrl: concurrentValue, slackChannel: '#changed' } } })
          .where(eq(partners.id, partner.id));
      },
    });

    expect(raced).toBe(true);
    expect(result.partners).toEqual({ scanned: 1, sealed: 1, contended: 0, failed: 0 });
    const n = (await readSettings(partners, partner.id)).notifications;
    // The concurrent save won; its value (not the stale one) is what got sealed.
    expect(n.slackChannel).toBe('#changed');
    expectSealedTo('partners', n.slackWebhookUrl, concurrentValue);
  });

  it('gives up on a row that keeps changing, leaving it for the next run untouched', async () => {
    const partner = await createPartner();
    await getTestDb().update(partners)
      .set({ settings: { notifications: { pushoverAppToken: 'token-0' } } })
      .where(eq(partners.id, partner.id));

    let saves = 0;
    const result = await sealUnsealedSettingsSecrets({
      maxAttempts: 2,
      beforeWrite: async (table, id) => {
        if (table !== 'partners' || id !== partner.id) return;
        saves += 1;
        await getTestDb().update(partners)
          .set({ settings: { notifications: { pushoverAppToken: `token-${saves}` } } })
          .where(eq(partners.id, partner.id));
      },
    });

    expect(result.partners).toEqual({ scanned: 1, sealed: 0, contended: 1, failed: 0 });
    expect((await readSettings(partners, partner.id)).notifications.pushoverAppToken).toBe('token-2');
  });

  it('does not select a row whose only non-sealed list entries are not strings', async () => {
    const partner = await createPartner();
    const sealed = encryptColumnValueForWrite('partners', 'settings', {
      notifications: { webhooks: ['https://hooks.example.com/x'] },
    }) as Record<string, any>;
    await getTestDb().update(partners)
      .set({ settings: { notifications: { webhooks: [...sealed.notifications.webhooks, 42, null] } } })
      .where(eq(partners.id, partner.id));

    const result = await sealUnsealedSettingsSecrets();

    expect(result.partners.scanned).toBe(0);
  });

  it('ignores a sealed value it cannot open rather than touching it', async () => {
    const partner = await createPartner();
    const foreign = encryptSecret('sealed-elsewhere', { aad: 'organizations.settings' })!;
    await getTestDb().update(partners)
      .set({ settings: { notifications: { pushoverAppToken: foreign } } })
      .where(eq(partners.id, partner.id));

    const result = await sealUnsealedSettingsSecrets();

    expect(result.partners.scanned).toBe(0);
    expect((await readSettings(partners, partner.id)).notifications.pushoverAppToken).toBe(foreign);
  });
});
