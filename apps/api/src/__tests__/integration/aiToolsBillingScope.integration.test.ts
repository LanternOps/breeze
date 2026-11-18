/**
 * Integration test — W14 PR A (#6784): the billing lifecycle tools honour the partner-wide gate, the org axis, the
 * site / device axes and the template ownership rules against real Postgres as the unprivileged `breeze_app` role.
 *
 * Entry point: `executeTool`, so the central `deviceArgs` gate runs before the handler as in production. The approval
 * step lives in the chat layer; this suite pins the CLASS each write is raised at and then tests what runs AFTER
 * approval (the release re-runs the handler), against stored rows:
 *   - rate cards and partner billing settings: a write lands only with canManagePartnerWidePolicies; another
 *     partner's card is not found and unchanged;
 *   - cross-org billing reads (another partner's org assignment, an org outside the caller's access, another org's
 *     template and signed agreements) are not found / absent;
 *   - template publish: an org template publishes; a partner-wide template and a site-restricted caller are refused
 *     and the version stays a draft;
 *   - signed-agreement link: two concurrent links of one document — exactly one lands (quorum QW5).
 * Every refusal has a CONTROL that lands the same call for the caller the guard admits. Nothing is stubbed.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import type { DbAccessContext } from '../../db';
import { withDbAccessContext } from '../../db';
import {
  billingProfiles, contractDocuments, contractTemplateVersions, contractTemplates, contracts, orgBillingProfileAssignments, partners,
} from '../../db/schema';
import { executeTool } from '../../services/aiTools';
import { checkGuardrails } from '../../services/aiGuardrails';
import { clearPermissionCache } from '../../services/permissions';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const AI_SESSION_ID = randomUUID();

function makeAuth(opts: {
  userId: string; partnerId: string; orgIds: string[]; scope?: 'organization' | 'partner';
  partnerOrgAccess?: 'all' | 'selected'; allowedSiteIds?: string[]; allowedDeviceIds?: string[];
}): AuthContext {
  const { allowedSiteIds, orgIds } = opts;
  const scope = opts.scope ?? 'organization';
  return {
    principal: { kind: 'user_session' },
    user: { id: opts.userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    partnerId: opts.partnerId,
    orgId: scope === 'organization' ? orgIds[0]! : null,
    scope,
    partnerOrgAccess: opts.partnerOrgAccess,
    accessibleOrgIds: orgIds,
    orgCondition: (col: any) => inArray(col, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
    allowedSiteIds,
    allowedDeviceIds: opts.allowedDeviceIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
    aiOrigin: { kind: 'ai_assistant', sessionId: AI_SESSION_ID },
  } as unknown as AuthContext;
}

function ctxFor(auth: AuthContext): DbAccessContext {
  return buildDbAccessContext({
    scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: auth.partnerId, userId: auth.user.id,
  });
}

async function run(tool: string, input: Record<string, unknown>, auth: AuthContext) {
  const raw = await withDbAccessContext(ctxFor(auth), () => executeTool(tool, input, auth));
  return { raw, body: JSON.parse(raw) as Record<string, any> };
}

async function seedProfile(partnerId: string, name: string): Promise<string> {
  const [row] = await getTestDb().insert(billingProfiles).values({
    partnerId, name, currencyCode: 'USD', baseCoverage: 'billable', baseHourlyRate: '150.00',
  } as typeof billingProfiles.$inferInsert).returning({ id: billingProfiles.id });
  return row!.id;
}

async function seedTemplate(owner: { orgId: string | null; partnerId: string | null }, status: 'draft' | 'published' = 'draft') {
  const db = getTestDb();
  const [template] = await db.insert(contractTemplates)
    .values({ orgId: owner.orgId, partnerId: owner.partnerId, name: `W14 MSA ${randomUUID().slice(0, 6)}` })
    .returning({ id: contractTemplates.id });
  const [version] = await db.insert(contractTemplateVersions).values({
    templateId: template!.id, orgId: owner.orgId, partnerId: owner.partnerId, versionNumber: 1, status,
    sourceType: 'authored', bodyHtml: '<p>W14 agreement body</p>', declaredVariables: [],
    ...(status === 'published' ? { sha256: 'c'.repeat(64), publishedAt: new Date() } : {}),
  } as typeof contractTemplateVersions.$inferInsert).returning({ id: contractTemplateVersions.id });
  return { templateId: template!.id, versionId: version!.id };
}

async function seedContract(partnerId: string, orgId: string, name: string): Promise<string> {
  const [row] = await getTestDb().insert(contracts).values({
    partnerId, orgId, name, billingTiming: 'advance', intervalMonths: 1, startDate: '2026-10-01', currencyCode: 'USD',
  } as typeof contracts.$inferInsert).returning({ id: contracts.id });
  return row!.id;
}

async function seedSignedAgreement(orgId: string): Promise<string> {
  const { templateId, versionId } = await seedTemplate({ orgId, partnerId: null }, 'published');
  const [doc] = await getTestDb().insert(contractDocuments).values({
    orgId, contractId: null, templateId, templateVersionId: versionId,
    pdfData: Buffer.from('%PDF-w14'), byteSize: 8, sha256: 'd'.repeat(64),
    signerName: 'Pat Signer', signerEmail: 'pat.signer@example.com',
  } as typeof contractDocuments.$inferInsert).returning({ id: contractDocuments.id });
  return doc!.id;
}

interface Fixture {
  partnerId: string; otherPartnerId: string; orgA: string; orgB: string; orgOther: string; siteA: string;
  profile: string; otherProfile: string;
  orgTemplate: { templateId: string; versionId: string };
  partnerTemplate: { templateId: string; versionId: string };
  orgBTemplate: { templateId: string; versionId: string };
  contractA1: string; contractA2: string; docA: string; docB: string; devB: string;
  auth: { partnerAll: AuthContext; partnerSel: AuthContext; orgAdmin: AuthContext; restricted: AuthContext };
}

async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const otherPartner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const orgOther = await createOrganization({ partnerId: otherPartner.id });
  const siteA = await createSite({ orgId: orgA.id, name: 'W14 A' });
  const siteB = await createSite({ orgId: orgB.id, name: 'W14 B' });
  const user = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `w14-${randomUUID()}@example.com` });
  const base = { userId: user.id, partnerId: partner.id };
  const devB = await createDevice({ orgId: orgB.id, siteId: siteB.id });
  return {
    partnerId: partner.id, otherPartnerId: otherPartner.id, orgA: orgA.id, orgB: orgB.id, orgOther: orgOther.id, siteA: siteA.id,
    profile: await seedProfile(partner.id, `W14 card ${randomUUID().slice(0, 6)}`),
    otherProfile: await seedProfile(otherPartner.id, `W14 other card ${randomUUID().slice(0, 6)}`),
    orgTemplate: await seedTemplate({ orgId: orgA.id, partnerId: null }),
    partnerTemplate: await seedTemplate({ orgId: null, partnerId: partner.id }),
    orgBTemplate: await seedTemplate({ orgId: orgB.id, partnerId: null }),
    contractA1: await seedContract(partner.id, orgA.id, 'W14 contract 1'),
    contractA2: await seedContract(partner.id, orgA.id, 'W14 contract 2'),
    docA: await seedSignedAgreement(orgA.id),
    docB: await seedSignedAgreement(orgB.id),
    devB: devB.id,
    auth: {
      partnerAll: makeAuth({ ...base, orgIds: [orgA.id, orgB.id], scope: 'partner', partnerOrgAccess: 'all' }),
      partnerSel: makeAuth({ ...base, orgIds: [orgA.id], scope: 'partner', partnerOrgAccess: 'selected' }),
      orgAdmin: makeAuth({ ...base, orgIds: [orgA.id] }),
      restricted: makeAuth({ ...base, orgIds: [orgA.id], allowedSiteIds: [siteA.id] }),
    },
  };
}

let f: Fixture;
beforeEach(async () => {
  clearPermissionCache();
  f = await seedFixture();
});

describe('the class each write is raised at', () => {
  runDb('every rate-card / settings write, template publish / archive / draft version and document link is supervised', () => {
    for (const action of ['create', 'update', 'archive', 'set_rows', 'clone', 'create_work_type', 'update_work_type', 'set_org_profile', 'clear_org_profile']) {
      expect(checkGuardrails('manage_billing_profiles', { action }), action).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    }
    for (const action of ['update_partner', 'update_org']) {
      expect(checkGuardrails('manage_billing_settings', { action }), action).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    }
    for (const action of ['create_version', 'publish', 'archive']) {
      expect(checkGuardrails('manage_contract_templates', { action }), action).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    }
    expect(checkGuardrails('manage_contract_templates', { action: 'create', ownerScope: 'partner' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    expect(checkGuardrails('manage_contract_templates', { action: 'create', ownerScope: 'organization' })).toMatchObject({ tier: 2 });
    expect(checkGuardrails('manage_contract_documents', { action: 'link' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
  });
});

describe('partner-wide rate cards and settings', () => {
  const profileRow = async (id: string) => (await getTestDb().select().from(billingProfiles).where(eq(billingProfiles.id, id)))[0];

  runDb('a rate-card write needs canManagePartnerWidePolicies (CONTROL: full partner access creates and updates)', async () => {
    const name = `W14 new ${randomUUID().slice(0, 6)}`;
    const sel = await run('manage_billing_profiles', { action: 'create', name, currencyCode: 'USD', baseCoverage: 'billable', baseHourlyRate: '99.00' }, f.auth.partnerSel);
    expect(sel.body.code, sel.raw).toBe('ACCESS_DENIED');
    expect(await getTestDb().select().from(billingProfiles).where(eq(billingProfiles.name, name))).toHaveLength(0);
    const upd = await run('manage_billing_profiles', { action: 'update', profileId: f.profile, baseHourlyRate: '1.00' }, f.auth.partnerSel);
    expect(upd.body.code, upd.raw).toBe('ACCESS_DENIED');
    expect((await profileRow(f.profile))!.baseHourlyRate).toBe('150.00');

    const all = await run('manage_billing_profiles', { action: 'create', name, currencyCode: 'USD', baseCoverage: 'billable', baseHourlyRate: '99.00' }, f.auth.partnerAll);
    expect(all.body.profile?.id, all.raw).toBeTruthy();
    expect(await profileRow(all.body.profile.id)).toMatchObject({ partnerId: f.partnerId, baseHourlyRate: '99.00' });
    const ok = await run('manage_billing_profiles', { action: 'update', profileId: f.profile, baseHourlyRate: '175.00' }, f.auth.partnerAll);
    expect(ok.body.before?.baseHourlyRate, ok.raw).toBe('150.00');
    expect((await profileRow(f.profile))!.baseHourlyRate).toBe('175.00');
  });

  runDb('another partner\'s rate card is not found and unchanged', async () => {
    const out = await run('manage_billing_profiles', { action: 'update', profileId: f.otherProfile, baseHourlyRate: '1.00' }, f.auth.partnerAll);
    expect(out.body.code, out.raw).toBe('PROFILE_NOT_FOUND');
    expect((await profileRow(f.otherProfile))!.baseHourlyRate).toBe('150.00');
    const list = await run('manage_billing_profiles', { action: 'list' }, f.auth.partnerAll);
    expect((list.body.profiles as Array<{ id: string }>).map((p) => p.id)).not.toContain(f.otherProfile);
  });

  runDb('partner billing settings change only with full partner access (CONTROL: it lands and returns the previous value)', async () => {
    const terms = async () => (await getTestDb().select({ t: partners.invoiceTermsDays }).from(partners).where(eq(partners.id, f.partnerId)))[0]!.t;
    const before = await terms();
    const next = before === 17 ? 18 : 17;
    const sel = await run('manage_billing_settings', { action: 'update_partner', partnerPatch: { invoiceTermsDays: next } }, f.auth.partnerSel);
    expect(sel.body.code, sel.raw).toBe('ACCESS_DENIED');
    expect(await terms()).toBe(before);
    const all = await run('manage_billing_settings', { action: 'update_partner', partnerPatch: { invoiceTermsDays: next } }, f.auth.partnerAll);
    expect(all.body.before, all.raw).toEqual({ invoiceTermsDays: before });
    expect(await terms()).toBe(next);
  });

  runDb('an org rate-card assignment: another partner\'s org is not found (CONTROL: an own org is assigned)', async () => {
    const other = await run('manage_billing_profiles', { action: 'set_org_profile', orgId: f.orgOther, profileId: f.profile }, f.auth.partnerAll);
    expect(other.body.code, other.raw).toBe('NOT_FOUND');
    expect(await getTestDb().select().from(orgBillingProfileAssignments).where(eq(orgBillingProfileAssignments.orgId, f.orgOther))).toHaveLength(0);
    const own = await run('manage_billing_profiles', { action: 'set_org_profile', orgId: f.orgA, profileId: f.profile }, f.auth.partnerAll);
    expect(own.body.assignment?.billingProfileId, own.raw).toBe(f.profile);
    const [row] = await getTestDb().select().from(orgBillingProfileAssignments).where(eq(orgBillingProfileAssignments.orgId, f.orgA));
    expect(row).toMatchObject({ billingProfileId: f.profile, assignedBy: (f.auth.partnerAll as AuthContext).user.id });
  });
});

describe('cross-org billing reads', () => {
  runDb('reads outside the caller\'s orgs are not found or absent (CONTROL: the same read for an own org)', async () => {
    expect((await run('manage_billing_settings', { action: 'get_org', orgId: f.orgB }, f.auth.partnerSel)).body.code).toBe('NOT_FOUND');
    expect((await run('manage_billing_settings', { action: 'get_org', orgId: f.orgA }, f.auth.partnerSel)).body.settings?.id).toBe(f.orgA);
    expect((await run('manage_billing_profiles', { action: 'get_org_profile', orgId: f.orgOther }, f.auth.partnerAll)).body.code).toBe('NOT_FOUND');

    const tpl = await run('manage_contract_templates', { action: 'get', templateId: f.orgBTemplate.templateId }, f.auth.orgAdmin);
    expect(tpl.body.error, tpl.raw).toBeTruthy();
    expect(tpl.raw).not.toContain('W14 agreement body');
    const own = await run('manage_contract_templates', { action: 'get', templateId: f.orgTemplate.templateId }, f.auth.orgAdmin);
    expect(own.body.template?.id, own.raw).toBe(f.orgTemplate.templateId);

    const docs = await run('manage_contract_documents', { action: 'list', linked: 'all' }, f.auth.orgAdmin);
    const ids = (docs.body.documents as Array<{ id: string }>).map((d) => d.id);
    expect(ids, docs.raw).toContain(f.docA);
    expect(ids).not.toContain(f.docB);
    expect(docs.raw).not.toContain('pat.signer@example.com');

    const dev = await run('get_device_billing', { deviceId: f.devB }, f.auth.partnerSel);
    expect(dev.body.error, dev.raw).toBeTruthy();
    expect(dev.body.billing).toBeUndefined();
  });
});

describe('agreement template publish', () => {
  const versionStatus = async (id: string) =>
    (await getTestDb().select({ s: contractTemplateVersions.status }).from(contractTemplateVersions).where(eq(contractTemplateVersions.id, id)))[0]!.s;

  runDb('a partner-wide template and a site-restricted caller are refused (CONTROL: the org admin publishes)', async () => {
    const pw = await run('manage_contract_templates', { action: 'publish', templateId: f.partnerTemplate.templateId, versionId: f.partnerTemplate.versionId }, f.auth.partnerAll);
    expect(pw.body.code, pw.raw).toBe('ACCESS_DENIED');
    expect(await versionStatus(f.partnerTemplate.versionId)).toBe('draft');

    const restricted = await run('manage_contract_templates', { action: 'publish', templateId: f.orgTemplate.templateId, versionId: f.orgTemplate.versionId }, f.auth.restricted);
    expect(restricted.body.code, restricted.raw).toBe('ACCESS_DENIED');
    expect(await versionStatus(f.orgTemplate.versionId)).toBe('draft');

    const ok = await run('manage_contract_templates', { action: 'publish', templateId: f.orgTemplate.templateId, versionId: f.orgTemplate.versionId }, f.auth.orgAdmin);
    expect(ok.body.version?.status, ok.raw).toBe('published');
    expect(ok.raw).not.toContain('W14 agreement body');
    expect(await versionStatus(f.orgTemplate.versionId)).toBe('published');
  });

  runDb('an update asserting the wrong owner is refused (CONTROL: the right assertion renames)', async () => {
    const wrong = await run('manage_contract_templates', { action: 'update', templateId: f.partnerTemplate.templateId, name: 'renamed' }, f.auth.partnerAll);
    expect(wrong.body.code, wrong.raw).toBe('OWNER_SCOPE_MISMATCH');
    const right = await run('manage_contract_templates', { action: 'update', templateId: f.partnerTemplate.templateId, ownerScope: 'partner', name: 'renamed' }, f.auth.partnerAll);
    expect(right.body.template?.name, right.raw).toBe('renamed');
    const [row] = await getTestDb().select().from(contractTemplates).where(eq(contractTemplates.id, f.partnerTemplate.templateId));
    expect(row!.name).toBe('renamed');
  });
});

describe('signed-agreement link', () => {
  runDb('two concurrent links of one document: exactly one lands, the other is ALREADY_LINKED (quorum QW5)', async () => {
    const [a, b] = await Promise.all([
      run('manage_contract_documents', { action: 'link', documentId: f.docA, contractId: f.contractA1 }, f.auth.orgAdmin),
      run('manage_contract_documents', { action: 'link', documentId: f.docA, contractId: f.contractA2 }, f.auth.orgAdmin),
    ]);
    const outcomes = [a.body, b.body];
    const winners = outcomes.filter((o) => o.linked === true);
    expect(winners, `${a.raw} | ${b.raw}`).toHaveLength(1);
    expect(outcomes.filter((o) => o.code === 'ALREADY_LINKED')).toHaveLength(1);
    const [row] = await getTestDb().select().from(contractDocuments).where(eq(contractDocuments.id, f.docA));
    expect(row!.contractId).toBe(winners[0]!.contractId);
    expect(JSON.stringify(winners[0])).not.toContain('pat.signer');
  });

  runDb('a site-restricted caller cannot file an agreement (CONTROL: a later link by the org admin is ALREADY_LINKED-safe)', async () => {
    const out = await run('manage_contract_documents', { action: 'link', documentId: f.docA, contractId: f.contractA1 }, f.auth.restricted);
    expect(out.body.code, out.raw).toBe('ACCESS_DENIED');
    const [row] = await getTestDb().select().from(contractDocuments).where(eq(contractDocuments.id, f.docA));
    expect(row!.contractId).toBeNull();
    const ok = await run('manage_contract_documents', { action: 'link', documentId: f.docA, contractId: f.contractA1 }, f.auth.orgAdmin);
    expect(ok.body.linked, ok.raw).toBe(true);
  });
});
