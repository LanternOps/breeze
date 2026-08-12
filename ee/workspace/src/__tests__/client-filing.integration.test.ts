// /client filing surface — real-DB integration (:5433, two-role).
//
// This suite exists to close a gap the unit suites structurally cannot:
// Task 6's matcher tests mock db.execute, so its visibility gate, org scoping,
// and date window were only ever proven at SQL-TEXT level. Everything below is
// behavioral, against real rows under the RLS-enforced app role:
//   - a file under a GROUPED source is unreachable through /client/filing/match
//     (groupIds [] → ungrouped only, fail closed);
//   - an identical-subject email in ANOTHER org is never returned;
//   - the 7-day window includes its boundary and excludes the far side of it.
// Plus the cross-path invariant the demo depends on: filing the same email to
// the same project through /client and through the device/helper route
// converges on ONE row with a stable status.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Hono } from 'hono';
import type { ExtensionHelperDevice, WorkspaceDatabase } from '../hostTypes';
import { createCrosswalkService } from '../services/crosswalkService';
import { createEmailMatchService } from '../services/emailMatchService';
import { createFileQueryService } from '../services/fileQueryService';
import { createActivityService } from '../services/activityService';
import { createFilingService, type FilingRecord } from '../services/filingService';
import { getOrgSettings } from '../services/orgSettingsService';
import { createClientRoutes } from '../routes/client';
import { createHelperRoutes } from '../routes/helper';
import type { WorkspaceAuthContext, WorkspaceRouteEnv } from '../routes/adminGate';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const APP_URL = process.env.DATABASE_URL_APP ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
if (new URL(ADMIN_URL).port === '5432') throw new Error('refusing to run against :5432 — use the test stack (:5433)');

let admin: postgres.Sql;
let app: postgres.Sql;
let appDb: ReturnType<typeof drizzle>;
let partner: string;
/** orgA: the demo org (content ON). orgB: a second tenant with a colliding
 * subject. orgOff: content never enabled (no settings row → default-deny). */
let orgA: string, orgB: string, orgOff: string;
let visibleSource: string, groupedSource: string, orgBSource: string;
const ids: Record<string, string> = {};

const USER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
/** Anchor for every seeded email date; the window probes are offsets of it. */
const BASE = new Date('2026-07-14T10:00:00.000Z');
const day = (n: number) => new Date(BASE.getTime() + n * 86_400_000).toISOString();
const minutes = (n: number) => new Date(BASE.getTime() + n * 60_000).toISOString();

interface SeedFile {
  key: string;
  org: 'A' | 'B';
  rel: string;
  source?: 'visible' | 'grouped' | 'orgB';
  entities?: Array<{ type: string; value: string; origin?: string }>;
  emailMeta?: { subject: string; from: string; date: string; messageId?: string };
}

const HERO_SUBJECT = 'PO 4021 pipe submittal';
const GROUPED_SUBJECT = 'grouped source only submittal';
const CROSS_ORG_SUBJECT = 'cross tenant only submittal';
const SHARED_SUBJECT = 'shared subject both tenants';
const WINDOW_SUBJECT = 'window boundary probe';

const SEED: SeedFile[] = [
  // Crosswalk evidence: PO 4021 on two filed Henderson files → dominant.
  { key: 'ev1', org: 'A', rel: 'Projects/2023-041 Henderson Water Main Replacement/transmittal.md', entities: [{ type: 'po', value: 'PO 4021' }] },
  { key: 'ev2', org: 'A', rel: 'Emails/2023-041/po issued.eml', entities: [{ type: 'po', value: 'PO 4021' }] },
  // The message the pane opens on.
  {
    key: 'hero', org: 'A', rel: 'Emails/Unfiled/re po 4021 pipe submittal.eml',
    entities: [{ type: 'po', value: 'PO 4021' }, { type: 'org', value: 'City of Fairoaks', origin: 'llm' }],
    emailMeta: {
      subject: `RE: ${HERO_SUBJECT}`,
      from: 'Paul Deluca <pdeluca@fairoaksca.gov>',
      date: BASE.toISOString(),
      messageId: 'hero-4021@fairoaksca.gov',
    },
  },
  // Visibility: identical shape, but its source carries a group claim the
  // client session does not have.
  {
    key: 'grouped', org: 'A', rel: 'Emails/Unfiled/grouped submittal.eml', source: 'grouped',
    emailMeta: { subject: GROUPED_SUBJECT, from: 'pdeluca@fairoaksca.gov', date: BASE.toISOString(), messageId: 'grouped@fairoaksca.gov' },
  },
  // Org scoping: only tenant B has this subject…
  {
    key: 'crossOnly', org: 'B', rel: 'Emails/Unfiled/cross tenant submittal.eml', source: 'orgB',
    emailMeta: { subject: CROSS_ORG_SUBJECT, from: 'pdeluca@fairoaksca.gov', date: BASE.toISOString(), messageId: 'cross@fairoaksca.gov' },
  },
  // …and both tenants have this one, byte-identical.
  {
    key: 'sharedA', org: 'A', rel: 'Emails/Unfiled/shared subject a.eml',
    emailMeta: { subject: SHARED_SUBJECT, from: 'pdeluca@fairoaksca.gov', date: BASE.toISOString() },
  },
  {
    key: 'sharedB', org: 'B', rel: 'Emails/Unfiled/shared subject b.eml', source: 'orgB',
    emailMeta: { subject: SHARED_SUBJECT, from: 'pdeluca@fairoaksca.gov', date: BASE.toISOString() },
  },
  // Date window boundary.
  {
    key: 'window', org: 'A', rel: 'Emails/Unfiled/window boundary probe.eml',
    emailMeta: { subject: WINDOW_SUBJECT, from: 'pdeluca@fairoaksca.gov', date: BASE.toISOString() },
  },
];

function orgAuth(orgId: string): WorkspaceAuthContext {
  return {
    user: { id: USER_ID, email: 'jenny@fairoaksca.gov', name: 'Jenny Tran' },
    scope: 'organization',
    orgId,
    partnerId: undefined,
    accessibleOrgIds: [orgId],
  } as WorkspaceAuthContext;
}

function helperDevice(orgId: string): ExtensionHelperDevice {
  return {
    id: DEVICE_ID, agentId: 'agent-1', orgId, siteId: null,
    hostname: 'FRONT-DESK-01', osType: 'windows', osVersion: '11', agentVersion: '1.0.0',
  };
}

/**
 * Run one request through the real extension routes inside an RLS-scoped
 * transaction — the same session-variable contract the host establishes, and
 * the reason these assertions are worth more than the mocked unit suites.
 */
async function request(
  orgId: string,
  path: string,
  init: RequestInit = {},
  options: { auth?: WorkspaceAuthContext | null; surface?: 'client' | 'helper' } = {},
): Promise<Response> {
  return appDb.transaction(async (transaction) => {
    const tx = (transaction as unknown as { session: { client: postgres.TransactionSql } }).session.client;
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${orgId}, true),
                    set_config('breeze.accessible_org_ids', ${orgId}, true),
                    set_config('breeze.accessible_partner_ids', ${partner}, true),
                    set_config('breeze.user_id', ${USER_ID}, true),
                    set_config('breeze.current_partner_id', '', true)`;
    const db = transaction as unknown as WorkspaceDatabase;
    const filingService = createFilingService(db, { crosswalkService: createCrosswalkService(db) });
    const getSettings = async (id: string) => ({
      contentEnabled: (await getOrgSettings(db, id)).contentEnabled,
    });
    const server = new Hono<WorkspaceRouteEnv>();
    if (options.surface === 'helper') {
      server.use('*', async (c, next) => {
        c.set('helperDevice' as never, helperDevice(orgId) as never);
        await next();
      });
      server.route('/', createHelperRoutes({
        fileQueryService: createFileQueryService(db),
        activityService: createActivityService(db),
        filingService,
        getSettings,
        audit: async () => {},
        log: () => {},
      }) as unknown as Hono<WorkspaceRouteEnv>);
    } else {
      const auth = options.auth === undefined ? orgAuth(orgId) : options.auth;
      server.use('*', async (c, next) => {
        if (auth) c.set('auth', auth);
        await next();
      });
      server.route('/', createClientRoutes({
        emailMatchService: createEmailMatchService(db),
        filingService,
        getSettings,
        audit: async () => {},
        log: () => {},
      }));
    }
    return server.request(path, init);
  });
}

/** Same RLS-scoped transaction, but handing the raw services to the caller —
 * used for the inverse control on the visibility gate. */
async function inOrg<T>(orgId: string, fn: (db: WorkspaceDatabase) => Promise<T>): Promise<T> {
  return appDb.transaction(async (transaction) => {
    const tx = (transaction as unknown as { session: { client: postgres.TransactionSql } }).session.client;
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${orgId}, true),
                    set_config('breeze.accessible_org_ids', ${orgId}, true),
                    set_config('breeze.accessible_partner_ids', ${partner}, true),
                    set_config('breeze.user_id', ${USER_ID}, true),
                    set_config('breeze.current_partner_id', '', true)`;
    return fn(transaction as unknown as WorkspaceDatabase);
  });
}

function matchPath(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `/filing/match?${query}`;
}

type MatchBody = { match: { fileIndexId: string; tier: number; filing: FilingRecord | null } | null };

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1 });
  app = postgres(APP_URL, { max: 1 });
  appDb = drizzle(app);
  partner = randomUUID();
  orgA = randomUUID(); orgB = randomUUID(); orgOff = randomUUID();
  visibleSource = randomUUID(); groupedSource = randomUUID(); orgBSource = randomUUID();
  const sfx = randomUUID();
  await admin`INSERT INTO partners (id, name, slug) VALUES (${partner}, 'wsp-client', ${`wsp-client-${sfx}`})`;
  for (const [id, label] of [[orgA, 'a'], [orgB, 'b'], [orgOff, 'off']] as const) {
    await admin`INSERT INTO organizations (id, partner_id, name, slug)
                VALUES (${id}, ${partner}, ${`wsp-client-${label}`}, ${`wsp-client-${label}-${sfx}`})`;
  }
  // Content ON for the two tenants that serve the client surface; orgOff gets
  // NO settings row at all — default-deny is the behavior under test.
  await admin`INSERT INTO workspace_org_settings (org_id, content_enabled)
              VALUES (${orgA}, true), (${orgB}, true)`;
  await admin`INSERT INTO workspace_sources (id, org_id, kind, display_name, root_path, visibility_group_ids)
              VALUES (${visibleSource}, ${orgA}, 'smb_share', 'estate', '\\\\srv\\estate', '[]'::jsonb),
                     (${groupedSource}, ${orgA}, 'smb_share', 'legal', '\\\\srv\\legal', '["g1"]'::jsonb),
                     (${orgBSource}, ${orgB}, 'smb_share', 'estate-b', '\\\\srv\\estate-b', '[]'::jsonb)`;
  await admin`INSERT INTO workspace_projects (org_id, project_key, label)
              VALUES (${orgA}, '2023-041', 'Henderson Water Main Replacement'),
                     (${orgA}, '2025-012', 'Fairoaks Tank No 2 Seismic Retrofit')`;

  for (const f of SEED) {
    const id = randomUUID();
    ids[f.key] = id;
    const org = f.org === 'A' ? orgA : orgB;
    const srcId = f.source === 'grouped' ? groupedSource : f.source === 'orgB' ? orgBSource : visibleSource;
    const name = f.rel.split('/').pop()!;
    const parent = f.rel.slice(0, f.rel.lastIndexOf('/'));
    const ext = name.split('.').pop()!.toLowerCase();
    await admin`INSERT INTO workspace_file_index (id, org_id, source_id, rel_path, parent_path, name, is_dir, ext, size, mtime)
                VALUES (${id}, ${org}, ${srcId}, ${f.rel}, ${parent}, ${name}, false, ${ext}, 100, now())`;
    for (const e of f.entities ?? []) {
      await admin`INSERT INTO workspace_content_entities (org_id, file_index_id, entity_type, value_norm, origin)
                  VALUES (${org}, ${id}, ${e.type}, ${e.value}, ${e.origin ?? 'regex'})`;
    }
    const m = f.rel.match(/^Projects\/(\d{4}-\d{3})|^Emails\/(\d{4}-\d{3})\//);
    const declaredKey = m ? (m[1] ?? m[2]) : null;
    if (declaredKey || f.emailMeta) {
      // admin.json(), NOT `${JSON.stringify(x)}::jsonb`: postgres.js treats the
      // ::jsonb cast as a type hint and JSON-encodes the string it is given, so
      // the stringify form lands a jsonb STRING SCALAR in the column and every
      // `email_meta ->> 'subject'` in the matcher reads null. Seeding it wrong
      // would have made this whole suite pass vacuously.
      await admin`INSERT INTO workspace_file_enrichment (org_id, file_index_id, declared_project_key, declared_project_label, email_meta)
                  VALUES (${org}, ${id}, ${declaredKey},
                          ${declaredKey === '2023-041' ? 'Henderson Water Main Replacement' : null},
                          ${f.emailMeta ? admin.json(f.emailMeta) : null})`;
    }
  }

  // Mine the crosswalk so the hero email's classify has real evidence.
  await appDb.transaction(async (transaction) => {
    const tx = (transaction as unknown as { session: { client: postgres.TransactionSql } }).session.client;
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${orgA}, true),
                    set_config('breeze.accessible_org_ids', ${orgA}, true),
                    set_config('breeze.accessible_partner_ids', ${partner}, true),
                    set_config('breeze.user_id', '', true),
                    set_config('breeze.current_partner_id', '', true)`;
    await createCrosswalkService(transaction as unknown as WorkspaceDatabase).run(orgA);
  });
});

afterAll(async () => {
  for (const org of [orgA, orgB, orgOff]) {
    for (const t of ['workspace_email_filings', 'workspace_project_crosswalk', 'workspace_content_entities',
      'workspace_file_enrichment', 'workspace_file_content', 'workspace_projects',
      'workspace_file_index', 'workspace_org_settings', 'workspace_sources']) {
      await admin.unsafe(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
    }
    await admin`DELETE FROM organizations WHERE id = ${org}`;
  }
  await admin`DELETE FROM partners WHERE id = ${partner}`;
  await admin.end(); await app.end();
});

describe('/client gate and content gate (real DB)', () => {
  it('serves an organization-scoped session', async () => {
    const res = await request(orgA, '/content/projects');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projects: [
        { key: '2023-041', label: 'Henderson Water Main Replacement' },
        { key: '2025-012', label: 'Fairoaks Tank No 2 Seismic Retrofit' },
      ],
    });
  });

  it('rejects a partner-scoped principal with 403 — /client is end-user only', async () => {
    const res = await request(orgA, '/content/projects', {}, {
      auth: { ...orgAuth(orgA), scope: 'partner', partnerId: partner } as WorkspaceAuthContext,
    });
    expect(res.status).toBe(403);
  });

  it('404s content_disabled for an org with no settings row (default-deny)', async () => {
    const res = await request(orgOff, '/content/projects');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'content_disabled' });
  });
});

describe('GET /client/filing/match (real DB)', () => {
  it('matches the open message and classifies it on demand', async () => {
    const res = await request(orgA, matchPath({
      subject: `RE: ${HERO_SUBJECT}`,
      sender: 'pdeluca@fairoaksca.gov',
      date: minutes(30),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as MatchBody;
    expect(body.match?.fileIndexId).toBe(ids.hero);
    expect(body.match?.tier).toBe(2);
    // classify-on-demand ran against real crosswalk evidence
    expect(body.match?.filing).toMatchObject({
      status: 'suggested',
      suggestedProjectKey: '2023-041',
      confidence: 'high',
      matchedEntityValue: 'PO 4021',
    });
  });

  it('matches on internetMessageId at tier 1', async () => {
    const res = await request(orgA, matchPath({
      subject: 'anything at all', internetMessageId: '<Hero-4021@fairoaksca.gov>',
    }));
    const body = await res.json() as MatchBody;
    expect(body.match?.fileIndexId).toBe(ids.hero);
    expect(body.match?.tier).toBe(1);
  });

  // VISIBILITY (behavioral, not SQL-text): the file exists, is an .eml, is in
  // the caller's org, and its subject/date match exactly — the ONLY reason it
  // must not come back is that its source carries a group claim the client
  // session does not have (groupIds []).
  it('never matches a file whose source is grouped', async () => {
    const byDate = await request(orgA, matchPath({
      subject: GROUPED_SUBJECT, sender: 'pdeluca@fairoaksca.gov', date: BASE.toISOString(),
    }));
    expect(await byDate.json()).toEqual({ match: null });

    // …and not through the strongest tier either.
    const byMessageId = await request(orgA, matchPath({
      subject: GROUPED_SUBJECT, internetMessageId: 'grouped@fairoaksca.gov',
    }));
    expect(await byMessageId.json()).toEqual({ match: null });

    // INVERSE CONTROL — without this the two nulls above would be satisfied by
    // a mis-seeded row that nothing could ever match. Handed the group claim
    // the client session lacks, the very same probe finds the very same file:
    // the group gate is the only thing hiding it.
    const withClaim = await inOrg(orgA, (db) => createEmailMatchService(db).match(orgA, {
      subject: GROUPED_SUBJECT, sender: 'pdeluca@fairoaksca.gov', dateISO: BASE.toISOString(),
    }, ['g1']));
    expect(withClaim).toEqual({ fileIndexId: ids.grouped, tier: 2 });
  });

  // ORG SCOPING (behavioral): identical subject, identical sender, identical
  // date — different tenant.
  it('never matches an identical-subject email in another org', async () => {
    const foreignOnly = await request(orgA, matchPath({
      subject: CROSS_ORG_SUBJECT, sender: 'pdeluca@fairoaksca.gov', date: BASE.toISOString(),
    }));
    expect(await foreignOnly.json()).toEqual({ match: null });

    // Inverse control: tenant B finds its own file with the identical probe.
    const ownedByB = await request(orgB, matchPath({
      subject: CROSS_ORG_SUBJECT, sender: 'pdeluca@fairoaksca.gov', date: BASE.toISOString(),
    }));
    expect(((await ownedByB.json()) as MatchBody).match?.fileIndexId).toBe(ids.crossOnly);

    // Both tenants hold the same subject: each sees only its own file, and the
    // collision does not make the match ambiguous across the tenant boundary.
    const fromA = await request(orgA, matchPath({
      subject: SHARED_SUBJECT, sender: 'pdeluca@fairoaksca.gov', date: BASE.toISOString(),
    }));
    expect(((await fromA.json()) as MatchBody).match?.fileIndexId).toBe(ids.sharedA);

    const fromB = await request(orgB, matchPath({
      subject: SHARED_SUBJECT, sender: 'pdeluca@fairoaksca.gov', date: BASE.toISOString(),
    }));
    expect(((await fromB.json()) as MatchBody).match?.fileIndexId).toBe(ids.sharedB);
  });

  // DATE WINDOW (behavioral, real timestamptz arithmetic): inclusive at ±7d.
  it.each([
    ['inside the window (+6d)', day(6), true],
    ['on the boundary (+7d exactly)', day(7), true],
    ['on the boundary (-7d exactly)', day(-7), true],
    ['past the boundary (+7d 1m)', new Date(BASE.getTime() + 7 * 86_400_000 + 60_000).toISOString(), false],
    ['past the boundary (-8d)', day(-8), false],
  ])('date window: %s → matched=%s', async (_label, probeDate, expected) => {
    const res = await request(orgA, matchPath({ subject: WINDOW_SUBJECT, date: probeDate }));
    const body = await res.json() as MatchBody;
    expect(body.match?.fileIndexId ?? null).toBe(expected ? ids.window : null);
  });

  it('answers match null when nothing in the estate resembles the probe', async () => {
    const res = await request(orgA, matchPath({
      subject: 'no such message anywhere', date: BASE.toISOString(),
    }));
    expect(await res.json()).toEqual({ match: null });
  });
});

describe('POST /client/filing/:id/assign (real DB)', () => {
  async function assign(orgId: string, fileIndexId: string, projectKey: string) {
    return request(orgId, `/filing/${fileIndexId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ projectKey }),
      headers: { 'content-type': 'application/json' },
    });
  }

  async function filingRows(fileIndexId: string) {
    return admin`SELECT status, decided_project_key, decided_label
                 FROM workspace_email_filings WHERE file_index_id = ${fileIndexId}`;
  }

  it('404s an unknown project and a malformed id without writing anything', async () => {
    expect((await assign(orgA, ids.window, '9999-999')).status).toBe(404);
    expect((await assign(orgA, 'not-a-uuid', '2023-041')).status).toBe(404);
  });

  // The invariant the demo rests on: the pane and the tray file into the SAME
  // row. Same fileIndexId + same projectKey through either path converges —
  // one row, stable status, no duplicate.
  it('is idempotent with the device/helper filing path', async () => {
    // The hero email already has a suggestion (classified via /filing/match).
    const viaClient = await assign(orgA, ids.hero, '2023-041');
    expect(viaClient.status).toBe(200);
    expect(((await viaClient.json()) as { filing: FilingRecord }).filing).toMatchObject({
      status: 'confirmed', decidedProjectKey: '2023-041',
    });
    const afterClient = await filingRows(ids.hero);
    expect(afterClient).toHaveLength(1);
    expect(afterClient[0].decided_label).toBe('Jenny Tran');

    // Same file, same project, the OTHER path (helper/device route).
    const viaHelper = await request(orgA, `/filing/${ids.hero}/assign`, {
      method: 'POST',
      body: JSON.stringify({ projectKey: '2023-041', helperUser: 'Front desk' }),
      headers: { 'content-type': 'application/json' },
    }, { surface: 'helper' });
    expect(viaHelper.status).toBe(200);
    expect(((await viaHelper.json()) as { filing: FilingRecord }).filing).toMatchObject({
      status: 'confirmed', decidedProjectKey: '2023-041',
    });

    const afterHelper = await filingRows(ids.hero);
    expect(afterHelper).toHaveLength(1);
    expect(afterHelper[0].status).toBe('confirmed');
    expect(afterHelper[0].decided_project_key).toBe('2023-041');

    // And back through /client once more: still one row, still confirmed.
    expect((await assign(orgA, ids.hero, '2023-041')).status).toBe(200);
    const afterRepeat = await filingRows(ids.hero);
    expect(afterRepeat).toHaveLength(1);
    expect(afterRepeat[0].status).toBe('confirmed');
  });

  it('re-matching after a decision returns the decided row without re-classifying', async () => {
    const res = await request(orgA, matchPath({
      subject: `RE: ${HERO_SUBJECT}`, sender: 'pdeluca@fairoaksca.gov', date: BASE.toISOString(),
    }));
    const body = await res.json() as MatchBody;
    expect(body.match?.filing).toMatchObject({
      status: 'confirmed', decidedProjectKey: '2023-041',
    });
  });

  it('cannot file a file that belongs to another org', async () => {
    const res = await assign(orgA, ids.crossOnly, '2023-041');
    expect(res.status).toBe(404);
    // Tenant B classified this file for itself earlier; tenant A's attempt
    // must leave that row completely undecided.
    const rows = await filingRows(ids.crossOnly);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'suggested', decided_project_key: null });
  });

  // C-1 regression. A 404 alone is NOT evidence the write was blocked: the
  // UPDATE used to run keyed on (org_id, file_index_id) only, and the
  // visibility check happened afterwards — so a caller with no group claims
  // could blind-write a human filing decision onto a file it is forbidden to
  // see and still be told "not found". Seed a filing row on the grouped file
  // (as admin — nothing the client surface can reach could ever create one)
  // so the assertion has something to be mutated, then prove it is untouched.
  it('cannot file a file whose source is grouped — and writes nothing', async () => {
    await admin`INSERT INTO workspace_email_filings
                  (org_id, file_index_id, status, suggested_project_key, confidence, rationale)
                VALUES (${orgA}, ${ids.grouped}, 'suggested', '2025-012', 'low', 'seeded for the write-gate probe')
                ON CONFLICT (file_index_id) DO NOTHING`;

    const res = await assign(orgA, ids.grouped, '2023-041');
    expect(res.status).toBe(404);

    const rows = await filingRows(ids.grouped);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'suggested', decided_project_key: null, decided_label: null,
    });
  });
});
