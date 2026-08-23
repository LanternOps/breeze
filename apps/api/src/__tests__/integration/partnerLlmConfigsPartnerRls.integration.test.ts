import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { partnerLlmConfigs } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function partnerContext(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [],
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

const configValues = {
  apiKeyEncrypted: 'enc:test-key',
  keyLast4: 'test',
  keyFingerprint: 'test-fingerprint',
};

describe('partner_llm_configs partner-axis RLS', () => {
  runDb('rejects a forged cross-partner INSERT with 42501', async () => {
    const [partnerA, partnerB] = await withSystemDbAccessContext(async () => [
      await createPartner(),
      await createPartner(),
    ]);

    await expect(
      withDbAccessContext(partnerContext(partnerA.id), () =>
        db.insert(partnerLlmConfigs).values({
          partnerId: partnerB.id,
          ...configValues,
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('partner A cannot SELECT partner B config', async () => {
    const [partnerA, partnerB] = await withSystemDbAccessContext(async () => [
      await createPartner(),
      await createPartner(),
    ]);
    const [configB] = await withSystemDbAccessContext(() =>
      db
        .insert(partnerLlmConfigs)
        .values({ partnerId: partnerB.id, ...configValues })
        .returning({ id: partnerLlmConfigs.id }),
    );

    const visible = await withDbAccessContext(partnerContext(partnerA.id), () =>
      db
        .select({ id: partnerLlmConfigs.id })
        .from(partnerLlmConfigs)
        .where(eq(partnerLlmConfigs.id, configB!.id)),
    );

    expect(visible).toEqual([]);
  });

  runDb('org-scoped context cannot read partner config rows', async () => {
    const { partner, org } = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      return { partner, org };
    });
    const [config] = await withSystemDbAccessContext(() =>
      db
        .insert(partnerLlmConfigs)
        .values({ partnerId: partner.id, ...configValues })
        .returning({ id: partnerLlmConfigs.id }),
    );

    const visible = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: partnerLlmConfigs.id })
        .from(partnerLlmConfigs)
        .where(eq(partnerLlmConfigs.id, config!.id)),
    );

    expect(visible).toEqual([]);
  });

  runDb('partner scope can SELECT, UPDATE, and DELETE its own config row', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    const [inserted] = await withSystemDbAccessContext(() =>
      db
        .insert(partnerLlmConfigs)
        .values({ partnerId: partner.id, ...configValues })
        .returning({ id: partnerLlmConfigs.id }),
    );

    const visible = await withDbAccessContext(partnerContext(partner.id), () =>
      db
        .select({ id: partnerLlmConfigs.id })
        .from(partnerLlmConfigs)
        .where(eq(partnerLlmConfigs.id, inserted!.id)),
    );
    expect(visible).toEqual([{ id: inserted!.id }]);

    const updated = await withDbAccessContext(partnerContext(partner.id), () =>
      db
        .update(partnerLlmConfigs)
        .set({ defaultModel: 'claude-haiku-4-5' })
        .where(eq(partnerLlmConfigs.id, inserted!.id))
        .returning({ id: partnerLlmConfigs.id, defaultModel: partnerLlmConfigs.defaultModel }),
    );
    expect(updated).toEqual([{ id: inserted!.id, defaultModel: 'claude-haiku-4-5' }]);

    const deleted = await withDbAccessContext(partnerContext(partner.id), () =>
      db
        .delete(partnerLlmConfigs)
        .where(eq(partnerLlmConfigs.id, inserted!.id))
        .returning({ id: partnerLlmConfigs.id }),
    );
    expect(deleted).toEqual([{ id: inserted!.id }]);
  });

  runDb('system context can write and read config rows', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    const [inserted] = await withSystemDbAccessContext(() =>
      db
        .insert(partnerLlmConfigs)
        .values({ partnerId: partner.id, ...configValues })
        .returning({ id: partnerLlmConfigs.id }),
    );

    const visible = await withSystemDbAccessContext(() =>
      db
        .select({ id: partnerLlmConfigs.id })
        .from(partnerLlmConfigs)
        .where(eq(partnerLlmConfigs.id, inserted!.id)),
    );

    expect(visible).toEqual([{ id: inserted!.id }]);
  });
});
