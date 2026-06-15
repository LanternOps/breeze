/**
 * client_ai_prompt_templates ROUTE-level dual-axis proof (spec §10 warning).
 *
 * Drives the real adminTemplates routes against the real docker postgres as
 * breeze_app: a partner-wide POST (org_id NULL) must succeed under the
 * dual-axis policies of 2026-06-12-b-client-ai-foundation.sql, and the
 * created row must be invisible to a different partner. The rls-coverage
 * contract test provably cannot catch a missing partner axis; only this
 * functional path can (custom_field_definitions lesson, 2026-06-11-i).
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

let activeAuthContext: {
  scope: 'partner';
  partnerId: string;
  accessibleOrgIds: string[];
} | null = null;

vi.mock('../../middleware/auth', async () => {
  const { withDbAccessContext } = await import('../../db');
  return {
    authMiddleware: (c: any, next: any) => {
      if (!activeAuthContext) return c.json({ error: 'Unauthorized' }, 401);
      c.set('auth', {
        scope: activeAuthContext.scope,
        partnerId: activeAuthContext.partnerId,
        orgId: null,
        accessibleOrgIds: activeAuthContext.accessibleOrgIds,
        user: { id: null, email: 'integration@test' },
      });
      // Same context shape the real authMiddleware opens (middleware/auth.ts:440-447).
      return withDbAccessContext(
        {
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: activeAuthContext.accessibleOrgIds,
          accessiblePartnerIds: [activeAuthContext.partnerId],
          userId: null,
        },
        () => next()
      );
    },
    requirePermission: () => (_c: any, next: any) => next(),
    requireMfa: () => (_c: any, next: any) => next(),
  };
});

vi.mock('../../config/env', () => ({
  CLIENT_AI_ENTRA_CLIENT_ID: '00000000-aaaa-bbbb-cccc-000000000001',
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

import { db, withDbAccessContext } from '../../db';
import { clientAiPromptTemplates } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const created: string[] = [];

afterEach(async () => {
  if (created.length === 0) return;
  await withDbAccessContext(
    { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null },
    async () => {
      for (const id of created) {
        await db.delete(clientAiPromptTemplates).where(eq(clientAiPromptTemplates.id, id));
      }
    }
  );
  created.length = 0;
});

beforeEach(() => {
  activeAuthContext = null;
});

async function buildApp() {
  // Import AFTER mocks are registered.
  const { clientAiAdminTemplateRoutes } = await import('../../routes/clientAi/adminTemplates');
  const { authMiddleware } = await import('../../middleware/auth');
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/client-ai/admin', clientAiAdminTemplateRoutes);
  return app;
}

const JSON_HEADERS = { Authorization: 'Bearer x', 'Content-Type': 'application/json' };

describe('adminTemplates routes against real RLS (breeze_app)', () => {
  it('POST creates a partner-wide template (org_id NULL) — the §10 write path', async () => {
    const partner = await createPartner();
    activeAuthContext = { scope: 'partner', partnerId: partner.id, accessibleOrgIds: [] };

    const app = await buildApp();
    const res = await app.request('/client-ai/admin/templates', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: 'Partner-wide variance template',
        promptBody: 'Explain the variance in the selection.',
        orgId: null,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.template.orgId).toBeNull();
    expect(body.template.partnerId).toBe(partner.id);
    created.push(body.template.id);

    // And the list sees it back through the same partner scope.
    const list = await app.request('/client-ai/admin/templates', { headers: JSON_HEADERS });
    const listBody = await list.json();
    expect(listBody.data.map((t: { id: string }) => t.id)).toContain(body.template.id);
  });

  it('a different partner cannot see the row (RLS, not app filtering)', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();

    activeAuthContext = { scope: 'partner', partnerId: partnerA.id, accessibleOrgIds: [] };
    let app = await buildApp();
    const createRes = await app.request('/client-ai/admin/templates', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'A-only', promptBody: 'x', orgId: null }),
    });
    const { template } = await createRes.json();
    created.push(template.id);

    activeAuthContext = { scope: 'partner', partnerId: partnerB.id, accessibleOrgIds: [] };
    app = await buildApp();
    const list = await app.request('/client-ai/admin/templates', { headers: JSON_HEADERS });
    const listBody = await list.json();
    expect(listBody.data.map((t: { id: string }) => t.id)).not.toContain(template.id);

    const update = await app.request(`/client-ai/admin/templates/${template.id}`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'hijacked' }),
    });
    expect(update.status).toBe(404); // RLS-invisible == not found
  });

  it('POST creates an org-scoped template under the org axis', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeAuthContext = { scope: 'partner', partnerId: partner.id, accessibleOrgIds: [org.id] };

    const app = await buildApp();
    const res = await app.request('/client-ai/admin/templates', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Org template', promptBody: 'y', orgId: org.id }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.template.orgId).toBe(org.id);
    expect(body.template.partnerId).toBeNull();
    created.push(body.template.id);
  });
});
