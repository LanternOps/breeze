/**
 * partner_ai_models tool profile + context window columns (#11394, feature
 * #11393): the new columns inherit the table's partner-axis RLS, the four
 * CHECKs fire against real Postgres, and the migration replays cleanly.
 * Reads/writes under test go through the breeze_app pool; seeds use the
 * superuser fixture client.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import {
  closeRegistryFixtures,
  fixtureSql as adminSql,
  orgContext,
  partnerContext,
  seedOffering,
  seedPlatformModel,
} from './aiModelRegistryFixtures';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

const MIGRATION = '2027-01-23-100000-partner-ai-models-tool-profile.sql';
const migrationSql = readFileSync(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');

async function partnerWithOrg() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  return { partner, org };
}

/** An offering carrying non-default tool-profile facts so reads prove the columns, not the defaults. */
async function seedProfiledOffering(partnerId: string, enabled: boolean): Promise<string> {
  const id = await seedOffering({ partnerId, platformModelId: await seedPlatformModel(), enabled });
  await adminSql`
    UPDATE partner_ai_models
       SET tool_profile = 'custom',
           tool_allowlist = ${adminSql.json({ domains: ['devices'], tools: [] })},
           context_window_override = 32000,
           context_window_discovered = 64000,
           context_window_observed = 8192,
           context_window_observed_at = now(),
           context_window_observed_config_version = 3
     WHERE id = ${id}`;
  return id;
}

const selectRow = (id: string) => db.execute(sql`
  SELECT id, tool_profile, tool_allowlist, context_window_override, context_window_discovered,
         context_window_observed, context_window_observed_at, context_window_observed_config_version
    FROM partner_ai_models WHERE id = ${id}`);

const updateProfile = (id: string, profile = 'standard') => db.execute(sql`
  UPDATE partner_ai_models SET tool_profile = ${profile}, tool_allowlist = NULL WHERE id = ${id} RETURNING id`);

describe.skipIf(!RUN)('partner_ai_models tool profile columns (#11394)', () => {
  it('an org context reads the new columns on its partner\'s ENABLED row, not partner B\'s; system scope reads B', async () => {
    const a = await partnerWithOrg();
    const b = await partnerWithOrg();
    const rowA = await seedProfiledOffering(a.partner.id, true);
    const rowB = await seedProfiledOffering(b.partner.id, true);

    const own = [...await withDbAccessContext(orgContext(a.org.id, a.partner.id), () => selectRow(rowA))];
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      tool_profile: 'custom',
      tool_allowlist: { domains: ['devices'], tools: [] },
      context_window_override: 32000,
      context_window_discovered: 64000,
      context_window_observed: 8192,
      context_window_observed_config_version: 3,
    });
    expect(own[0]!.context_window_observed_at).toBeTruthy();

    const foreign = await withDbAccessContext(orgContext(a.org.id, a.partner.id), () => selectRow(rowB));
    expect([...foreign]).toEqual([]);

    const control = await withSystemDbAccessContext(() => selectRow(rowB));
    expect([...control]).toHaveLength(1);
  });

  it('an org context sees no DISABLED row of its own partner; system scope does', async () => {
    const a = await partnerWithOrg();
    const disabled = await seedProfiledOffering(a.partner.id, false);
    const seen = await withDbAccessContext(orgContext(a.org.id, a.partner.id), () => selectRow(disabled));
    expect([...seen]).toEqual([]);
    const control = await withSystemDbAccessContext(() => selectRow(disabled));
    expect([...control]).toHaveLength(1);
  });

  it('partner B cannot read or UPDATE partner A\'s row; partner A\'s UPDATE affects 1 row', async () => {
    const a = await partnerWithOrg();
    const b = await partnerWithOrg();
    const rowA = await seedProfiledOffering(a.partner.id, true);

    const read = await withDbAccessContext(partnerContext(b.partner.id), () => selectRow(rowA));
    expect([...read]).toEqual([]);
    const upd = await withDbAccessContext(partnerContext(b.partner.id), () => updateProfile(rowA));
    expect([...upd]).toEqual([]);
    const [still] = await adminSql`SELECT tool_profile FROM partner_ai_models WHERE id = ${rowA}`;
    expect(still!.tool_profile).toBe('custom');

    const own = await withDbAccessContext(partnerContext(a.partner.id), () => updateProfile(rowA));
    expect([...own]).toHaveLength(1);
    const [after] = await adminSql`SELECT tool_profile FROM partner_ai_models WHERE id = ${rowA}`;
    expect(after!.tool_profile).toBe('standard');
  });

  it('an org context cannot UPDATE tool_profile (zero rows); the partner context can', async () => {
    const a = await partnerWithOrg();
    const rowA = await seedProfiledOffering(a.partner.id, true);

    const org = await withDbAccessContext(orgContext(a.org.id, a.partner.id), () => updateProfile(rowA));
    expect([...org]).toEqual([]);
    const [still] = await adminSql`SELECT tool_profile FROM partner_ai_models WHERE id = ${rowA}`;
    expect(still!.tool_profile).toBe('custom');

    const own = await withDbAccessContext(partnerContext(a.partner.id), () => updateProfile(rowA));
    expect([...own]).toHaveLength(1);
  });

  describe('CHECK constraints (23514)', () => {
    async function freshOffering() {
      const { partner } = await partnerWithOrg();
      return seedOffering({ partnerId: partner.id, platformModelId: await seedPlatformModel() });
    }

    it('rejects tool_profile=custom with a NULL allowlist', async () => {
      const id = await freshOffering();
      await expect(adminSql`UPDATE partner_ai_models SET tool_profile = 'custom' WHERE id = ${id}`)
        .rejects.toMatchObject({ code: '23514', constraint_name: 'partner_ai_models_tool_allowlist_chk' });
    });

    it('rejects tool_profile=standard with a non-null allowlist', async () => {
      const id = await freshOffering();
      await expect(adminSql`
        UPDATE partner_ai_models SET tool_profile = 'standard',
          tool_allowlist = ${adminSql.json({ domains: [], tools: [] })} WHERE id = ${id}`)
        .rejects.toMatchObject({ code: '23514', constraint_name: 'partner_ai_models_tool_allowlist_chk' });
    });

    it('rejects an unknown tool_profile', async () => {
      const id = await freshOffering();
      await expect(adminSql`UPDATE partner_ai_models SET tool_profile = 'huge' WHERE id = ${id}`)
        .rejects.toMatchObject({ code: '23514', constraint_name: 'partner_ai_models_tool_profile_chk' });
    });

    it('rejects context_window_override=1023 and accepts 1024', async () => {
      const id = await freshOffering();
      await expect(adminSql`UPDATE partner_ai_models SET context_window_override = 1023 WHERE id = ${id}`)
        .rejects.toMatchObject({ code: '23514', constraint_name: 'partner_ai_models_context_window_override_chk' });
      await adminSql`UPDATE partner_ai_models SET context_window_override = 1024 WHERE id = ${id}`;
    });

    it('rejects context_window_observed=8192 with a NULL observed_at, accepts the full triple', async () => {
      const id = await freshOffering();
      await expect(adminSql`UPDATE partner_ai_models SET context_window_observed = 8192 WHERE id = ${id}`)
        .rejects.toMatchObject({ code: '23514', constraint_name: 'partner_ai_models_context_window_observed_chk' });
      await adminSql`
        UPDATE partner_ai_models SET context_window_observed = 8192, context_window_observed_at = now(),
          context_window_observed_config_version = 1 WHERE id = ${id}`;
    });

    it('accepts a valid custom row', async () => {
      const id = await freshOffering();
      await adminSql`
        UPDATE partner_ai_models SET tool_profile = 'custom',
          tool_allowlist = ${adminSql.json({ domains: ['devices'], tools: [] })} WHERE id = ${id}`;
      const [row] = await adminSql`SELECT tool_profile, tool_allowlist FROM partner_ai_models WHERE id = ${id}`;
      expect(row).toMatchObject({ tool_profile: 'custom', tool_allowlist: { domains: ['devices'], tools: [] } });
    });
  });

  it('an offering inserted without the new columns reads auto with every other new column NULL', async () => {
    const { partner } = await partnerWithOrg();
    const id = await seedOffering({ partnerId: partner.id, platformModelId: await seedPlatformModel() });
    const [row] = await adminSql`
      SELECT tool_profile, tool_allowlist, context_window_override, context_window_discovered,
             context_window_observed, context_window_observed_at, context_window_observed_config_version
        FROM partner_ai_models WHERE id = ${id}`;
    expect(row).toEqual({
      tool_profile: 'auto',
      tool_allowlist: null,
      context_window_override: null,
      context_window_discovered: null,
      context_window_observed: null,
      context_window_observed_at: null,
      context_window_observed_config_version: null,
    });
  });

  it('the migration replays idempotently, leaving the four CHECKs in place', async () => {
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql.raw(migrationSql));
    });
    const checks = await adminSql`
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'public.partner_ai_models'::regclass AND conname = ANY (ARRAY[
         'partner_ai_models_tool_profile_chk', 'partner_ai_models_tool_allowlist_chk',
         'partner_ai_models_context_window_override_chk', 'partner_ai_models_context_window_observed_chk'])`;
    expect(checks).toHaveLength(4);
  });
});
