import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, gte, lte, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { clientAiUsage } from '../../db/schema/clientAi';
import { organizations } from '../../db/schema/orgs';
import { portalUsers } from '../../db/schema/portal';
import { requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { csvRow } from '../../services/spreadsheetExport';
import { resolveScopedOrgId } from '../c2c/helpers';
import { adminUsageQuerySchema } from './schemas';

/**
 * AI for Office — usage & billing report (spec §8, §9.4). Reads the
 * client_ai_usage monthly buckets (org × user × month) the Plan-2 session
 * loop writes; the CSV is the MSP's resale-invoicing artifact, so its column
 * order is a pinned contract. CSV building follows routes/tickets/export.ts
 * (csvRow — quoted + formula-neutralized cells); exports are audited like
 * routes/auditLogs.ts GET /export.
 */

export const clientAiAdminUsageRoutes = new Hono();

const requireOrgsRead = requirePermission(
  PERMISSIONS.ORGS_READ.resource,
  PERMISSIONS.ORGS_READ.action
);

const CSV_HEADERS = [
  'month',
  'org_name',
  'user_email',
  'messages',
  'sessions',
  'input_tokens',
  'output_tokens',
  'cost_cents',
];

type UsageQuery = { from: string; to: string; orgId?: string };

async function loadUsageRows(q: UsageQuery) {
  // period_key is 'YYYY-MM' for monthly rows — lexicographic range == calendar
  // range (same trick as the ai_cost_usage bucket pattern).
  const conditions: SQL[] = [
    eq(clientAiUsage.period, 'monthly'),
    gte(clientAiUsage.periodKey, q.from),
    lte(clientAiUsage.periodKey, q.to),
  ];
  if (q.orgId) conditions.push(eq(clientAiUsage.orgId, q.orgId));

  const rows = await db
    .select({
      periodKey: clientAiUsage.periodKey,
      orgId: clientAiUsage.orgId,
      orgName: organizations.name,
      clientUserId: clientAiUsage.clientUserId,
      userEmail: portalUsers.email,
      inputTokens: clientAiUsage.inputTokens,
      outputTokens: clientAiUsage.outputTokens,
      totalCostCents: clientAiUsage.totalCostCents,
      sessionCount: clientAiUsage.sessionCount,
      messageCount: clientAiUsage.messageCount,
    })
    .from(clientAiUsage)
    .leftJoin(organizations, eq(clientAiUsage.orgId, organizations.id))
    .leftJoin(portalUsers, eq(clientAiUsage.clientUserId, portalUsers.id))
    .where(and(...conditions))
    .orderBy(asc(clientAiUsage.periodKey), asc(organizations.name), asc(portalUsers.email));

  return rows.map((r) => ({
    month: r.periodKey,
    orgId: r.orgId,
    orgName: r.orgName ?? null,
    clientUserId: r.clientUserId,
    userEmail: r.userEmail ?? null,
    messageCount: Number(r.messageCount ?? 0),
    sessionCount: Number(r.sessionCount ?? 0),
    inputTokens: Number(r.inputTokens ?? 0),
    outputTokens: Number(r.outputTokens ?? 0),
    // totalCostCents is REAL (fractional cents accumulate) — round to 2dp.
    costCents: Math.round(Number(r.totalCostCents ?? 0) * 100) / 100,
  }));
}

function checkOrgAccess(
  c: { get: (k: 'auth') => Parameters<typeof resolveScopedOrgId>[0] },
  orgId: string | undefined
): boolean {
  if (!orgId) return true;
  return resolveScopedOrgId(c.get('auth'), orgId) !== null;
}

// ── GET /usage — JSON report ──────────────────────────────────────────────────
clientAiAdminUsageRoutes.get(
  '/usage',
  requireOrgsRead,
  zValidator('query', adminUsageQuerySchema),
  async (c) => {
    const q = c.req.valid('query');
    if (!checkOrgAccess(c as never, q.orgId)) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const rows = await loadUsageRows(q);
    const totals = rows.reduce(
      (acc, r) => ({
        messageCount: acc.messageCount + r.messageCount,
        sessionCount: acc.sessionCount + r.sessionCount,
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        costCents: Math.round((acc.costCents + r.costCents) * 100) / 100,
      }),
      { messageCount: 0, sessionCount: 0, inputTokens: 0, outputTokens: 0, costCents: 0 }
    );

    return c.json({ rows, totals });
  }
);

// ── GET /usage.csv — the invoicing artifact ──────────────────────────────────
clientAiAdminUsageRoutes.get(
  '/usage.csv',
  requireOrgsRead,
  zValidator('query', adminUsageQuerySchema),
  async (c) => {
    const q = c.req.valid('query');
    if (!checkOrgAccess(c as never, q.orgId)) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const rows = await loadUsageRows(q);

    writeRouteAudit(c, {
      orgId: q.orgId ?? null,
      action: 'client_ai.usage.export',
      resourceType: 'client_ai_usage',
      details: { from: q.from, to: q.to, orgId: q.orgId ?? null, rowCount: rows.length },
    });

    const lines = [CSV_HEADERS.join(',')];
    for (const r of rows) {
      lines.push(
        csvRow([
          r.month,
          r.orgName ?? '',
          r.userEmail ?? '',
          r.messageCount,
          r.sessionCount,
          r.inputTokens,
          r.outputTokens,
          r.costCents,
        ])
      );
    }

    c.header('Content-Type', 'text/csv');
    c.header(
      'Content-Disposition',
      `attachment; filename="client-ai-usage-${q.from}-to-${q.to}.csv"`
    );
    return c.body(lines.join('\n'));
  }
);
