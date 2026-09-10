/**
 * Real-Postgres coverage for the Office add-in draft's AI budget boundary.
 * The provider is a local mock: these tests exercise HTTP -> request RLS ->
 * budget rows/usage aggregates without sending customer text or credentials.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { aiBudgets, aiCostUsage, partners } from '../../db/schema';
import { buildDbAccessContext } from '../../middleware/auth';
import { createOrganization, createPartner, createUser } from './db-utils';

const { authRef, draftTicketFromEmail } = vi.hoisted(() => ({
  authRef: {
    current: null as null | { userId: string; partnerId: string; orgId: string },
  },
  draftTicketFromEmail: vi.fn(),
}));

vi.mock('../../middleware/officeAddinTechAuth', () => ({
  officeAddinTechAuthMiddleware: async (c: any, next: any) => {
    const principal = authRef.current!;
    c.set('officeAddinAuth', {
      userId: principal.userId,
      partnerId: principal.partnerId,
      bindingId: '00000000-0000-4000-8000-000000000111',
      token: 'synthetic-integration-token',
      user: { email: 'tech@example.test', name: 'Synthetic Tech' },
      accessibleOrgIds: [principal.orgId],
      partnerOrgAccess: 'selected',
      permissions: {},
      canAccessOrg: (orgId: string) => orgId === principal.orgId,
      canAccessSite: () => true,
    });
    return withDbAccessContext(
      buildDbAccessContext({
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: [principal.orgId],
        partnerId: principal.partnerId,
        userId: principal.userId,
      }),
      next,
    );
  },
  requireAddinCapability: () => async (_c: any, next: any) => next(),
}));

vi.mock('../../services/llm/llmConfigResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/llm/llmConfigResolver')>()),
  getAnthropicClientForPartner: vi.fn(async () => ({
    client: { messages: { create: vi.fn() } },
    resolved: {
      source: 'platform' as const,
      apiKey: 'synthetic-key',
      model: 'claude-sonnet-4-6',
    },
  })),
  resolveWireModel: vi.fn((_resolved: unknown, model: string) => ({ model })),
}));

vi.mock('../../services/officeAddin/aiEmailDraft', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/officeAddin/aiEmailDraft')>()),
  draftTicketFromEmail,
}));

import { officeAddinTicketRoutes } from '../../routes/officeAddin/tickets';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function app() {
  const instance = new Hono();
  instance.route('/tickets', officeAddinTicketRoutes);
  return instance;
}

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id });
  await withSystemDbAccessContext(() => db
    .update(partners)
    .set({ aiForOfficeEnabled: true })
    .where(eq(partners.id, partner.id)));
  authRef.current = { userId: user.id, partnerId: partner.id, orgId: org.id };
  return { partner, org };
}

async function callDraft(orgId: string) {
  return app().request('/tickets/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      orgId,
      subject: 'Synthetic Outlook failure',
      bodyText: 'A disposable fixture cannot open Outlook.',
    }),
  });
}

beforeEach(() => {
  draftTicketFromEmail.mockReset();
  draftTicketFromEmail.mockResolvedValue({
    subject: 'Fix Outlook startup',
    summary: 'The synthetic fixture reports a startup failure.',
    suggestedTimeMinutes: 15,
    inputTokens: 100,
    outputTokens: 50,
  });
  delete process.env.BILLING_SERVICE_URL;
  delete process.env.BILLING_SERVICE_API_KEY;
});

describe('Office add-in AI accounting', () => {
  runDb('denies an exhausted stored daily budget before the provider and leaves usage unchanged', async () => {
    const { org } = await seed();
    const periodKey = new Date().toISOString().slice(0, 10);
    await withSystemDbAccessContext(async () => {
      await db.insert(aiBudgets).values({ orgId: org.id, dailyBudgetCents: 1 });
      await db.insert(aiCostUsage).values({
        orgId: org.id,
        period: 'daily',
        periodKey,
        totalCostCents: 1,
        inputTokens: 7,
        outputTokens: 3,
        messageCount: 1,
      });
    });

    const response = await callDraft(org.id);

    expect(response.status).toBe(402);
    expect(draftTicketFromEmail).not.toHaveBeenCalled();
    const rows = await withSystemDbAccessContext(() => db
      .select({ inputTokens: aiCostUsage.inputTokens, outputTokens: aiCostUsage.outputTokens })
      .from(aiCostUsage)
      .where(and(
        eq(aiCostUsage.orgId, org.id),
        eq(aiCostUsage.period, 'daily'),
        eq(aiCostUsage.periodKey, periodKey),
      )));
    expect(rows).toEqual([{ inputTokens: 7, outputTokens: 3 }]);
  });

  runDb('allows an under-budget request and persists its real token counts as breeze_app', async () => {
    const { org } = await seed();
    await withSystemDbAccessContext(() => db
      .insert(aiBudgets)
      .values({ orgId: org.id, dailyBudgetCents: 10_000 }));

    const response = await callDraft(org.id);

    expect(response.status).toBe(200);
    expect(draftTicketFromEmail).toHaveBeenCalledTimes(1);
    const rows = await withSystemDbAccessContext(() => db
      .select({
        period: aiCostUsage.period,
        inputTokens: aiCostUsage.inputTokens,
        outputTokens: aiCostUsage.outputTokens,
        messageCount: aiCostUsage.messageCount,
      })
      .from(aiCostUsage)
      .where(eq(aiCostUsage.orgId, org.id)));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ period: 'daily', inputTokens: 100, outputTokens: 50, messageCount: 1 }),
      expect.objectContaining({ period: 'monthly', inputTokens: 100, outputTokens: 50, messageCount: 1 }),
    ]));
  });
});
