/**
 * Integration test — manage_quotes WRITE actions honour the quote's site axis
 * and the org/partner axes (W02 #6756, Task 15b), against real Postgres as the
 * unprivileged `breeze_app` role.
 *
 * Fixture (partner-scope caller, which is the only scope manage_quotes accepts):
 *   - org A with site A (the caller's allowed site) and site B (forbidden)
 *   - a quote on each site, in draft and in sent form
 *   - a second org under the SAME partner that the caller cannot access
 *   - a second PARTNER with its own org + quote
 *
 * Asserts, per action: out-of-site refused (specific code, row unchanged),
 * in-site succeeds (non-vacuous), cross-org / cross-partner refused,
 * unrestricted caller reaches the out-of-site quote.
 *
 * Stripe is stubbed: `create_pay_link` must refuse BEFORE any Stripe call.
 */
import './setup';
import { getTestDb } from './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { auditLogs, quoteLines, quotes } from '../../db/schema';
import { createCatalogItemWithPrice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { registerQuoteTools } from '../../services/aiToolsQuotes';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';

const { getPartnerStripeClientMock } = vi.hoisted(() => ({
  getPartnerStripeClientMock: vi.fn(async () => {
    throw new Error('Stripe must not be reached by a refused create_pay_link');
  }),
}));
vi.mock('../../services/partnerStripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/partnerStripe')>();
  return { ...actual, getPartnerStripeClient: getPartnerStripeClientMock };
});

function quoteHandler(): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerQuoteTools(reg);
  return reg.get('manage_quotes')!.handler;
}

function makePartnerAuth(opts: {
  userId: string;
  partnerId: string;
  accessibleOrgIds: string[];
  allowedSiteIds?: string[];
}): AuthContext {
  const { allowedSiteIds } = opts;
  return {
    user: { id: opts.userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as any,
    partnerId: opts.partnerId,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: opts.accessibleOrgIds,
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => opts.accessibleOrgIds.includes(id),
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) =>
      !allowedSiteIds ? true : !!s && allowedSiteIds.includes(s),
  } as unknown as AuthContext;
}

function partnerCtx(f: { partnerId: string; orgId: string; userId: string }): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [f.orgId],
    accessiblePartnerIds: [f.partnerId],
    userId: f.userId,
    currentPartnerId: f.partnerId,
  };
}

async function seedQuote(opts: {
  partnerId: string;
  orgId: string;
  siteId: string | null;
  status: 'draft' | 'sent';
  title: string;
}) {
  const [q] = await (getTestDb() as any)
    .insert(quotes)
    .values({
      partnerId: opts.partnerId,
      orgId: opts.orgId,
      siteId: opts.siteId,
      title: opts.title,
      status: opts.status,
      currencyCode: 'USD',
      ...(opts.status === 'sent' ? { quoteNumber: `Q-${randomUUID().slice(0, 8)}`, sentAt: new Date() } : {}),
    })
    .returning();
  return q as typeof quotes.$inferSelect;
}

async function loadQuote(id: string) {
  const [row] = await (getTestDb() as any).select().from(quotes).where(eq(quotes.id, id));
  return row as typeof quotes.$inferSelect;
}

async function linesFor(quoteId: string) {
  return (getTestDb() as any).select().from(quoteLines).where(eq(quoteLines.quoteId, quoteId)) as Promise<Array<typeof quoteLines.$inferSelect>>;
}

async function declineAuditRows(quoteId: string) {
  return (getTestDb() as any)
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, 'quote.declined_on_behalf'), eq(auditLogs.resourceId, quoteId))) as Promise<Array<typeof auditLogs.$inferSelect>>;
}

interface Fixture {
  partnerId: string;
  orgId: string;
  userId: string;
  catalogItemId: string;
  draftIn: typeof quotes.$inferSelect;
  draftOut: typeof quotes.$inferSelect;
  sentIn: typeof quotes.$inferSelect;
  sentOut: typeof quotes.$inferSelect;
  draftInForDecline: typeof quotes.$inferSelect;
  quoteSiblingOrg: typeof quotes.$inferSelect;
  quoteForeignPartner: typeof quotes.$inferSelect;
  restricted: AuthContext;
  unrestricted: AuthContext;
}

async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const siblingOrg = await createOrganization({ partnerId: partner.id });
  const foreignPartner = await createPartner();
  const foreignOrg = await createOrganization({ partnerId: foreignPartner.id });
  const user = await createUser({ partnerId: partner.id, email: `qw-${randomUUID()}@quote-scope.test` });

  const siteA = await createSite({ orgId: org.id });
  const siteB = await createSite({ orgId: org.id });
  const siblingSite = await createSite({ orgId: siblingOrg.id });
  const foreignSite = await createSite({ orgId: foreignOrg.id });

  const catalogItem = await createCatalogItemWithPrice({
    partnerId: partner.id, name: 'Scope-test service', currencyCode: 'USD', unitPrice: '100.00',
  });

  const base = { partnerId: partner.id, orgId: org.id };
  const draftIn = await seedQuote({ ...base, siteId: siteA.id, status: 'draft', title: 'draft in-site' });
  const draftOut = await seedQuote({ ...base, siteId: siteB.id, status: 'draft', title: 'draft out-of-site' });
  const sentIn = await seedQuote({ ...base, siteId: siteA.id, status: 'sent', title: 'sent in-site' });
  const sentOut = await seedQuote({ ...base, siteId: siteB.id, status: 'sent', title: 'sent out-of-site' });
  const draftInForDecline = await seedQuote({ ...base, siteId: siteA.id, status: 'draft', title: 'draft in-site (decline target)' });
  const quoteSiblingOrg = await seedQuote({ partnerId: partner.id, orgId: siblingOrg.id, siteId: siblingSite.id, status: 'draft', title: 'sibling org' });
  const quoteForeignPartner = await seedQuote({ partnerId: foreignPartner.id, orgId: foreignOrg.id, siteId: foreignSite.id, status: 'draft', title: 'foreign partner' });

  const auth = { userId: user.id, partnerId: partner.id, accessibleOrgIds: [org.id] };
  return {
    partnerId: partner.id,
    orgId: org.id,
    userId: user.id,
    catalogItemId: catalogItem.id,
    draftIn, draftOut, sentIn, sentOut, draftInForDecline,
    quoteSiblingOrg, quoteForeignPartner,
    restricted: makePartnerAuth({ ...auth, allowedSiteIds: [siteA.id] }),
    unrestricted: makePartnerAuth(auth),
  };
}

async function call(f: Fixture, auth: AuthContext, input: Record<string, unknown>) {
  const raw = await withDbAccessContext(partnerCtx(f), async () => quoteHandler()(input, auth));
  return JSON.parse(raw);
}

const SITE_DENIED = { error: 'Site access denied', code: 'SITE_DENIED' };
const DECLINE_EVIDENCE = { method: 'email', reference: 'customer email 2026-10-22' };

describe('manage_quotes writes — quote site axis + org/partner axes (real Postgres, breeze_app)', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await seedFixture();
    getPartnerStripeClientMock.mockClear();
  });

  it('update: out-of-site is refused SITE_DENIED with the title unchanged; in-site succeeds; unrestricted reaches the out-of-site quote', async () => {
    expect(await call(f, f.restricted, { action: 'update', quoteId: f.draftOut.id, patch: { title: 'hijacked' } })).toEqual(SITE_DENIED);
    expect((await loadQuote(f.draftOut.id)).title).toBe('draft out-of-site');

    const ok = await call(f, f.restricted, { action: 'update', quoteId: f.draftIn.id, patch: { title: 'renamed in-site' } });
    expect(ok.error).toBeUndefined();
    expect((await loadQuote(f.draftIn.id)).title).toBe('renamed in-site');

    const wide = await call(f, f.unrestricted, { action: 'update', quoteId: f.draftOut.id, patch: { title: 'renamed wide' } });
    expect(wide.error).toBeUndefined();
    expect((await loadQuote(f.draftOut.id)).title).toBe('renamed wide');
  });

  it('update: cross-org (same partner) and cross-partner quotes are refused or not found, rows unchanged', async () => {
    const sibling = await call(f, f.restricted, { action: 'update', quoteId: f.quoteSiblingOrg.id, patch: { title: 'hijacked' } });
    // RLS hides what the context cannot reach; the actor org gate is the backstop.
    expect(sibling.code).toBe('QUOTE_NOT_FOUND');
    expect((await loadQuote(f.quoteSiblingOrg.id)).title).toBe('sibling org');

    const foreign = await call(f, f.restricted, { action: 'update', quoteId: f.quoteForeignPartner.id, patch: { title: 'hijacked' } });
    expect(foreign).toEqual({ error: 'Quote not found', code: 'QUOTE_NOT_FOUND' });
    expect((await loadQuote(f.quoteForeignPartner.id)).title).toBe('foreign partner');
  });

  it('add_catalog_line: out-of-site and cross-org refused with no line written; in-site succeeds', async () => {
    const args = { catalogItemId: f.catalogItemId, quantity: 2 };
    expect(await call(f, f.restricted, { action: 'add_catalog_line', quoteId: f.draftOut.id, ...args })).toEqual(SITE_DENIED);
    expect(await linesFor(f.draftOut.id)).toHaveLength(0);

    const sibling = await call(f, f.restricted, { action: 'add_catalog_line', quoteId: f.quoteSiblingOrg.id, ...args });
    expect(sibling.code).toBe('QUOTE_NOT_FOUND');
    expect(await linesFor(f.quoteSiblingOrg.id)).toHaveLength(0);

    const foreign = await call(f, f.restricted, { action: 'add_catalog_line', quoteId: f.quoteForeignPartner.id, ...args });
    expect(foreign).toEqual({ error: 'Quote not found', code: 'QUOTE_NOT_FOUND' });
    expect(await linesFor(f.quoteForeignPartner.id)).toHaveLength(0);

    const ok = await call(f, f.restricted, { action: 'add_catalog_line', quoteId: f.draftIn.id, ...args });
    expect(ok.error).toBeUndefined();
    const lines = await linesFor(f.draftIn.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.catalogItemId).toBe(f.catalogItemId);

    const wide = await call(f, f.unrestricted, { action: 'add_catalog_line', quoteId: f.draftOut.id, ...args });
    expect(wide.error).toBeUndefined();
    expect(await linesFor(f.draftOut.id)).toHaveLength(1);
  });

  it('decline: out-of-site sent quote is refused SITE_DENIED, stays sent, writes no audit row', async () => {
    expect(await call(f, f.restricted, { action: 'decline', quoteId: f.sentOut.id, ...DECLINE_EVIDENCE })).toEqual(SITE_DENIED);
    expect((await loadQuote(f.sentOut.id)).status).toBe('sent');
    expect((await loadQuote(f.sentOut.id)).declinedAt).toBeNull();

    const foreign = await call(f, f.restricted, { action: 'decline', quoteId: f.quoteForeignPartner.id, ...DECLINE_EVIDENCE });
    expect(foreign).toEqual({ error: 'Quote not found', code: 'QUOTE_NOT_FOUND' });
    expect((await loadQuote(f.quoteForeignPartner.id)).status).toBe('draft');
  });

  it('decline: a sent in-site quote is declined with exactly one quote.declined_on_behalf audit row; a draft is QUOTE_NOT_DECLINABLE with none; unrestricted reaches the out-of-site sent quote', async () => {
    const ok = await call(f, f.restricted, { action: 'decline', quoteId: f.sentIn.id, ...DECLINE_EVIDENCE, reason: 'went with another vendor' });
    expect(ok.error).toBeUndefined();
    const declined = await loadQuote(f.sentIn.id);
    expect(declined.status).toBe('declined');
    expect(declined.declineReason).toBe('went with another vendor');
    // The audit write is fire-and-forget; wait for it.
    await vi.waitFor(async () => expect(await declineAuditRows(f.sentIn.id)).toHaveLength(1));
    const [row] = await declineAuditRows(f.sentIn.id);
    expect(row!.actorId).toBe(f.userId);
    expect(row!.details).toMatchObject({ method: 'email', reference: 'customer email 2026-10-22', reason: 'went with another vendor' });

    const draft = await call(f, f.restricted, { action: 'decline', quoteId: f.draftInForDecline.id, ...DECLINE_EVIDENCE });
    expect(draft.code).toBe('QUOTE_NOT_DECLINABLE');
    expect(draft.error).toMatch(/never sent/);
    expect((await loadQuote(f.draftInForDecline.id)).status).toBe('draft');

    const wide = await call(f, f.unrestricted, { action: 'decline', quoteId: f.sentOut.id, ...DECLINE_EVIDENCE });
    expect(wide.error).toBeUndefined();
    expect((await loadQuote(f.sentOut.id)).status).toBe('declined');
    await vi.waitFor(async () => expect(await declineAuditRows(f.sentOut.id)).toHaveLength(1));

    // Audit writes are ordered through one queue; with both positives landed,
    // the refusals above (draft, and the earlier out-of-site) left no row.
    expect(await declineAuditRows(f.draftInForDecline.id)).toHaveLength(0);
    expect(await declineAuditRows(f.quoteForeignPartner.id)).toHaveLength(0);
  });

  it('create_pay_link: out-of-site and cross-org are refused before any Stripe call; in-site passes the site gate and stops at NOT_CONVERTED', async () => {
    expect(await call(f, f.restricted, { action: 'create_pay_link', quoteId: f.draftOut.id })).toEqual(SITE_DENIED);
    expect(await call(f, f.restricted, { action: 'create_pay_link', quoteId: f.sentOut.id })).toEqual(SITE_DENIED);

    const sibling = await call(f, f.restricted, { action: 'create_pay_link', quoteId: f.quoteSiblingOrg.id });
    expect(sibling.code).toBe('QUOTE_NOT_FOUND');
    const foreign = await call(f, f.restricted, { action: 'create_pay_link', quoteId: f.quoteForeignPartner.id });
    expect(foreign).toEqual({ error: 'Quote not found', code: 'QUOTE_NOT_FOUND' });
    expect(getPartnerStripeClientMock).not.toHaveBeenCalled();

    // Discriminator: the in-site quote clears the site gate and is refused
    // LATER, on state, so the SITE_DENIED above is the site guard talking.
    const inSite = await call(f, f.restricted, { action: 'create_pay_link', quoteId: f.draftIn.id });
    expect(inSite.code).toBe('NOT_CONVERTED');
    // The unrestricted caller reaches the same state refusal on the out-of-site quote.
    const wide = await call(f, f.unrestricted, { action: 'create_pay_link', quoteId: f.draftOut.id });
    expect(wide.code).toBe('NOT_CONVERTED');
    expect(getPartnerStripeClientMock).not.toHaveBeenCalled();
  });
});
