// Crosswalk miner + filing pipeline — real-DB integration (:5433).
// Seeds the corpus's trap shapes: PO 4021 dominance, the PO 5117 foil, and
// the LS 8841 license/invoice digit collision. No LLM, no network — the
// pipeline under test is deterministic.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { WorkspaceDatabase } from '../hostTypes';
import { createCrosswalkService } from '../services/crosswalkService';
import { createFilingService } from '../services/filingService';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const APP_URL = process.env.DATABASE_URL_APP ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
if (new URL(ADMIN_URL).port === '5432') throw new Error('refusing to run against :5432 — use the test stack (:5433)');

let admin: postgres.Sql;
let app: postgres.Sql;
let appDb: ReturnType<typeof drizzle>;
let partner: string, org: string, source: string, hiddenSource: string;
const ids: Record<string, string> = {};

interface SeedFile {
  key: string;
  rel: string;
  entities?: Array<{ type: string; value: string; origin?: string }>;
  declared?: { key: string; label: string };
  emailMeta?: object;
  /** Seed into the hidden ('["g1"]') source instead of the visible estate. */
  sourceOverride?: 'hidden';
}

const SEED: SeedFile[] = [
  // PO 4021 → 2023-041, four distinct filed files (dominant)
  { key: 'h1', rel: 'Emails/2023-041/po issued.eml', entities: [{ type: 'po', value: 'PO 4021' }] },
  { key: 'h2', rel: 'Emails/2023-041/re po cortez.eml', entities: [{ type: 'po', value: 'PO 4021' }] },
  { key: 'h3', rel: 'Emails/2023-041/invoice 1 jtran.eml', entities: [{ type: 'po', value: 'PO 4021' }, { type: 'invoice', value: 'INV 23-1088' }, { type: 'person', value: 'Jenny Tran', origin: 'llm' }] },
  { key: 'h4', rel: 'Projects/2023-041 Henderson Water Main Replacement/transmittal.md', entities: [{ type: 'po', value: 'PO 4021' }] },
  // Jenny Tran also on a second Henderson file (participant-fallback evidence)
  { key: 'h5', rel: 'Emails/2023-041/status jtran.eml', entities: [{ type: 'person', value: 'Jenny Tran', origin: 'llm' }] },
  // PO 5117 → 2025-012 foil (two files, dominant for ITS value)
  { key: 't1', rel: 'Emails/2025-012/drain down window.eml', entities: [{ type: 'po', value: 'PO 5117' }] },
  { key: 't2', rel: 'Projects/2025-012 Fairoaks Tank No 2 Seismic Retrofit/eval.md', entities: [{ type: 'po', value: 'PO 5117' }] },
  // LS 8841 license trap on a Millbrook file
  { key: 'm1', rel: 'Projects/2020-088 Millbrook Acres Wildfire Rebuild/monument recovery.md', entities: [{ type: 'license', value: 'LS 8841' }] },
  // split entity: WDR-9999-0001 filed 1× under two projects (non-dominant)
  { key: 's1', rel: 'Projects/2023-041 Henderson Water Main Replacement/noa.md', entities: [{ type: 'wdr', value: 'WDR-9999-0001' }] },
  { key: 's2', rel: 'Projects/2025-012 Fairoaks Tank No 2 Seismic Retrofit/noa-copy.md', entities: [{ type: 'wdr', value: 'WDR-9999-0001' }] },
  // unfiled targets
  {
    key: 'hero', rel: 'Emails/Unfiled/new - re PO 4021 pipe submittal.eml',
    entities: [{ type: 'po', value: 'PO 4021' }, { type: 'org', value: 'City of Fairoaks', origin: 'llm' }],
    emailMeta: { subject: 'RE: PO 4021 - pipe submittal resubmittal', from: 'Paul Deluca <pdeluca@fairoaksca.gov>' },
  },
  {
    key: 'ambiguous', rel: 'Emails/Unfiled/pacific coast repro invoice question.eml',
    entities: [{ type: 'invoice', value: 'INV 8841' }, { type: 'person', value: 'Jenny Tran', origin: 'llm' }],
    emailMeta: { subject: 'invoice question', from: 'Pacific Coast Repro' },
  },
  {
    key: 'split-mail', rel: 'Emails/Unfiled/wdr question.eml',
    entities: [{ type: 'wdr', value: 'WDR-9999-0001' }],
  },
  // Fallback-hole guard: Ghost Analyst's ONLY participant evidence lives in a
  // hidden ('["g1"]') source. The participant fallback must not use it to file
  // a visible email — before Task 6 the fallback query had no source join.
  {
    key: 'ghost-file', rel: 'Projects/2099-999 Ghost Project/ghost.md',
    entities: [{ type: 'person', value: 'Ghost Analyst', origin: 'llm' }],
    sourceOverride: 'hidden',
  },
  {
    key: 'ghost-mail', rel: 'Emails/Unfiled/ghost participant question.eml',
    entities: [{ type: 'person', value: 'Ghost Analyst', origin: 'llm' }],
    emailMeta: { subject: 'ghost question', from: 'Ghost Analyst' },
  },
];

async function asOrg<T>(fn: (svcs: {
  crosswalk: ReturnType<typeof createCrosswalkService>;
  filing: ReturnType<typeof createFilingService>;
}) => Promise<T>): Promise<T> {
  return appDb.transaction(async (transaction) => {
    const tx = (transaction as unknown as { session: { client: postgres.TransactionSql } })
      .session.client;
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${org}, true),
                    set_config('breeze.accessible_org_ids', ${org}, true),
                    set_config('breeze.accessible_partner_ids', ${partner}, true),
                    set_config('breeze.user_id', '', true),
                    set_config('breeze.current_partner_id', '', true)`;
    const db = transaction as unknown as WorkspaceDatabase;
    const crosswalk = createCrosswalkService(db);
    const filing = createFilingService(db, { crosswalkService: crosswalk });
    return fn({ crosswalk, filing });
  });
}

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1 });
  app = postgres(APP_URL, { max: 1 });
  appDb = drizzle(app);
  partner = randomUUID(); org = randomUUID(); source = randomUUID(); hiddenSource = randomUUID();
  const sfx = randomUUID();
  await admin`INSERT INTO partners (id, name, slug) VALUES (${partner}, 'wsp-filing', ${`wsp-filing-${sfx}`})`;
  await admin`INSERT INTO organizations (id, partner_id, name, slug)
              VALUES (${org}, ${partner}, 'wsp-filing-org', ${`wsp-filing-org-${sfx}`})`;
  await admin`INSERT INTO workspace_sources (id, org_id, kind, display_name, root_path, visibility_group_ids)
              VALUES (${source}, ${org}, 'smb_share', 'estate', '\\\\srv\\estate', '[]'::jsonb),
                     (${hiddenSource}, ${org}, 'smb_share', 'hidden', '\\\\srv\\hidden', '["g1"]'::jsonb)`;
  await admin`INSERT INTO workspace_projects (org_id, project_key, label)
              VALUES (${org}, '2023-041', 'Henderson Water Main Replacement'),
                     (${org}, '2025-012', 'Fairoaks Tank No 2 Seismic Retrofit'),
                     (${org}, '2020-088', 'Millbrook Acres Wildfire Rebuild')`;
  for (const f of SEED) {
    const id = randomUUID();
    ids[f.key] = id;
    const name = f.rel.split('/').pop()!;
    const parent = f.rel.slice(0, f.rel.lastIndexOf('/'));
    const ext = name.split('.').pop()!.toLowerCase();
    const srcId = f.sourceOverride === 'hidden' ? hiddenSource : source;
    await admin`INSERT INTO workspace_file_index (id, org_id, source_id, rel_path, parent_path, name, is_dir, ext, size, mtime)
                VALUES (${id}, ${org}, ${srcId}, ${f.rel}, ${parent}, ${name}, false, ${ext}, 100, now())`;
    for (const e of f.entities ?? []) {
      await admin`INSERT INTO workspace_content_entities (org_id, file_index_id, entity_type, value_norm, origin)
                  VALUES (${org}, ${id}, ${e.type}, ${e.value}, ${e.origin ?? 'regex'})`;
    }
    // enrichment declared_* rows power the participant fallback
    const m = f.rel.match(/^(?:Projects|Short Term)\/(\d{4}-\d{3})|^Emails\/(\d{4}-\d{3})\//);
    const declaredKey = m ? (m[1] ?? m[2]) : null;
    if (declaredKey || f.emailMeta) {
      await admin`INSERT INTO workspace_file_enrichment (org_id, file_index_id, declared_project_key, declared_project_label, email_meta)
                  VALUES (${org}, ${id}, ${declaredKey},
                          ${declaredKey === '2023-041' ? 'Henderson Water Main Replacement' : declaredKey === '2025-012' ? 'Fairoaks Tank No 2 Seismic Retrofit' : declaredKey === '2020-088' ? 'Millbrook Acres Wildfire Rebuild' : null},
                          ${f.emailMeta ? JSON.stringify(f.emailMeta) : null}::jsonb)`;
    }
  }
});

afterAll(async () => {
  for (const t of ['workspace_email_filings', 'workspace_project_crosswalk', 'workspace_content_entities',
    'workspace_file_enrichment', 'workspace_file_content', 'workspace_projects',
    'workspace_file_index', 'workspace_sources']) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
  }
  await admin`DELETE FROM organizations WHERE id = ${org}`;
  await admin`DELETE FROM partners WHERE id = ${partner}`;
  await admin.end(); await app.end();
});

describe('crosswalk miner', () => {
  it('mines distinct-file evidence per (entity, project) and is idempotent', async () => {
    const first = await asOrg(({ crosswalk }) => crosswalk.run(org));
    expect(first.mined).toBeGreaterThanOrEqual(4);
    const again = await asOrg(({ crosswalk }) => crosswalk.run(org));
    expect(again.mined).toBe(first.mined);

    const po4021 = await asOrg(({ crosswalk }) => crosswalk.lookup(org, 'po', 'PO 4021'));
    expect(po4021).toHaveLength(1);
    expect(po4021[0]).toMatchObject({ projectKey: '2023-041', evidenceCount: 4 });

    // the unfiled hero email contributes NO evidence (no declared project)
    const rows = await admin`SELECT sample_file_ids FROM workspace_project_crosswalk
                             WHERE org_id = ${org} AND value_norm = 'PO 4021'`;
    expect(rows[0].sample_file_ids).not.toContain(ids.hero);
  });
});

describe('filing pipeline', () => {
  it('lists only unfiled emails', async () => {
    const filings = await asOrg(({ filing }) => filing.list(org));
    const rels = filings.map((f) => f.relPath);
    expect(rels).toEqual(expect.arrayContaining([
      'Emails/Unfiled/new - re PO 4021 pipe submittal.eml',
      'Emails/Unfiled/pacific coast repro invoice question.eml',
    ]));
    expect(rels).not.toContain('Emails/2023-041/po issued.eml');
  });

  it('hero email: dominant crosswalk hit → HIGH confidence, Henderson, org-flavored rationale', async () => {
    const filing = await asOrg(({ filing: f }) => f.classify(org, ids.hero));
    expect(filing).toMatchObject({
      suggestedProjectKey: '2023-041',
      suggestedProjectLabel: 'Henderson Water Main Replacement',
      confidence: 'high',
      matchedEntityType: 'po',
      matchedEntityValue: 'PO 4021',
      status: 'suggested',
    });
    expect(filing?.rationale).toBe('matched City of Fairoaks PO #4021');
  });

  it('ambiguous email: LS 8841 never matches invoice 8841; participant fallback is LOW', async () => {
    const filing = await asOrg(({ filing: f }) => f.classify(org, ids.ambiguous));
    expect(filing?.confidence).toBe('low');
    expect(filing?.suggestedProjectKey).not.toBe('2020-088'); // the collision trap
    expect(filing?.suggestedProjectKey).toBe('2023-041'); // Jenny Tran evidence
    expect(filing?.rationale).toMatch(/Jenny Tran/);
  });

  it('participant fallback ignores evidence from hidden sources (fallback hole gated)', async () => {
    // Ghost Analyst appears only in a hidden ('["g1"]') source. With the
    // participant fallback now visibility-gated (groupIds [] → ungrouped only),
    // that evidence is excluded, so the email gets no suggestion at all rather
    // than being misfiled to the hidden project 2099-999.
    const filing = await asOrg(({ filing: f }) => f.classify(org, ids['ghost-mail']));
    expect(filing?.suggestedProjectKey).toBeNull();
    expect(filing?.suggestedProjectKey).not.toBe('2099-999');
  });

  it('split-evidence entity (1v1 files) is never HIGH', async () => {
    const filing = await asOrg(({ filing: f }) => f.classify(org, ids['split-mail']));
    expect(filing?.confidence).toBe('low');
  });

  it('assign confirms on the suggested project and reassigns otherwise; unknown project → null', async () => {
    const confirmed = await asOrg(({ filing: f }) => f.assign(org, ids.hero, '2023-041', 'Front desk'));
    expect(confirmed?.status).toBe('confirmed');
    expect(confirmed?.decidedProjectKey).toBe('2023-041');

    const reassigned = await asOrg(({ filing: f }) => f.assign(org, ids.ambiguous, '2025-012', null));
    expect(reassigned?.status).toBe('reassigned');

    const bogus = await asOrg(({ filing: f }) => f.assign(org, ids.hero, '9999-999', null));
    expect(bogus).toBeNull();
  });

  it('re-classify never overwrites a human decision', async () => {
    // hero was confirmed to 2023-041 in the previous test
    const after = await asOrg(({ filing: f }) => f.classify(org, ids.hero));
    expect(after?.status).toBe('confirmed');
    expect(after?.decidedProjectKey).toBe('2023-041');
  });

  it('classify answers null for filed emails and unknown files (route 404s)', async () => {
    expect(await asOrg(({ filing: f }) => f.classify(org, ids.h1))).toBeNull();
    expect(await asOrg(({ filing: f }) => f.classify(org, randomUUID()))).toBeNull();
  });
});
