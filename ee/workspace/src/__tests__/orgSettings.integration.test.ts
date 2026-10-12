// putOrgSettings upsert — real-DB (#3474). Partial patches must preserve the
// fields they do not mention; previously only the insert path was exercised.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { WorkspaceDatabase } from '../hostTypes';
import { getOrgSettings, putOrgSettings, type DlpConfig } from '../services/orgSettingsService';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
if (new URL(ADMIN_URL).port === '5432') throw new Error('refusing to run against :5432 — use the test stack (:5433)');

let admin: postgres.Sql;
let db: WorkspaceDatabase;
let partner: string, org: string;

const CUSTOM: DlpConfig = {
  detectors: { credit_card: 'block', iban: 'log', ssn: 'redact', api_key: 'off', email: 'log', phone: 'off' },
  customPatterns: [{ name: 'employee-id', pattern: 'EMP-\\d{6}', action: 'redact' }],
};

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1 });
  db = drizzle(admin) as unknown as WorkspaceDatabase;
  partner = randomUUID(); org = randomUUID();
  const sfx = randomUUID();
  await admin`INSERT INTO partners (id, name, slug) VALUES (${partner}, 'wsp-settings', ${`wsp-settings-${sfx}`})`;
  await admin`INSERT INTO organizations (id, partner_id, name, slug, currency_code)
              VALUES (${org}, ${partner}, 'wsp-settings-org', ${`wsp-settings-org-${sfx}`}, 'USD')`;
});

afterAll(async () => {
  await admin`DELETE FROM workspace_org_settings WHERE org_id = ${org}`;
  await admin`DELETE FROM organizations WHERE id = ${org}`;
  await admin`DELETE FROM partners WHERE id = ${partner}`;
  await admin.end();
});

describe('putOrgSettings (real DB)', () => {
  it('insert then a contentEnabled-only patch preserves dlpConfig', async () => {
    await putOrgSettings(db, org, { contentEnabled: true, dlpConfig: CUSTOM });
    const after = await putOrgSettings(db, org, { contentEnabled: false });
    expect(after.contentEnabled).toBe(false);
    expect(after.dlpConfig).toEqual(CUSTOM);
    expect(await getOrgSettings(db, org)).toEqual(after);
  });

  it('a dlpConfig-only patch preserves contentEnabled', async () => {
    await putOrgSettings(db, org, { contentEnabled: true });
    const next: DlpConfig = { ...CUSTOM, detectors: { ...CUSTOM.detectors, email: 'block' } };
    const after = await putOrgSettings(db, org, { dlpConfig: next });
    expect(after.contentEnabled).toBe(true);
    expect(after.dlpConfig.detectors.email).toBe('block');
    expect(after.dlpConfig.customPatterns).toEqual(CUSTOM.customPatterns);
  });

  it('an empty patch on an existing row changes nothing', async () => {
    const before = await getOrgSettings(db, org);
    expect(await putOrgSettings(db, org, {})).toEqual(before);
  });
});
