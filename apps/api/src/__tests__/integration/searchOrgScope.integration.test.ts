/**
 * #9612 — GET /search (Cmd+K) honors the org selected in the switcher and
 * orders each category deterministically before its LIMIT, against a real
 * Postgres so the ranking SQL (CASE / starts_with / lower) actually executes
 * and RLS sits underneath the app-layer narrowing.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/searchOrgScope.integration.test.ts
 */
import './setup';

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { searchRoutes } from '../../routes/search';
import {
  createDevice,
  createIntegrationTestClient,
  createOrganization,
  createPartner,
  createSite,
  type IntegrationTestClient,
} from './db-utils';

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/search', searchRoutes);
  return app;
}

type Row = { id: string; type: string; title: string };

describe('GET /search — selected org + deterministic order (#9612)', () => {
  let client: IntegrationTestClient;
  let orgA: string;
  let siteA: string;
  let orgB: string;
  let siteB: string;

  beforeEach(async () => {
    client = await createIntegrationTestClient(buildApp(), { scope: 'partner' });
    orgA = client.env.organization.id;
    siteA = client.env.site.id;
    const second = await createOrganization({ partnerId: client.env.partner.id, name: 'Vega Corp' });
    orgB = second!.id;
    siteB = (await createSite({ orgId: orgB }))!.id;
  });

  async function devicesFor(path: string): Promise<Row[]> {
    const res = await client.get(path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Row[] };
    return body.results.filter((r) => r.type === 'devices');
  }

  it('narrows to the selected org; without one, spans every accessible org', async () => {
    const a = await createDevice({ orgId: orgA, siteId: siteA, hostname: 'ACME-SRV-02' });
    const b = await createDevice({ orgId: orgB, siteId: siteB, hostname: 'VEGA-SRV-02' });

    const narrowed = await devicesFor(`/search?q=srv-02&orgId=${orgA}`);
    expect(narrowed.map((r) => r.id)).toEqual([a.id]);

    const fleet = await devicesFor('/search?q=srv-02');
    expect(fleet.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('refuses an org outside the caller access with 403', async () => {
    const otherPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: otherPartner!.id });

    const res = await client.get(`/search?q=srv-02&orgId=${foreignOrg!.id}`);
    expect(res.status).toBe(403);
  });

  it('ranks exact, then prefix, then substring matches before the per-category limit', async () => {
    // Six substring-only matches would fill the 5-row device slot on their own.
    for (const host of ['a-srv-02', 'b-srv-02', 'c-srv-02', 'd-srv-02', 'e-srv-02', 'f-srv-02']) {
      await createDevice({ orgId: orgA, siteId: siteA, hostname: host });
    }
    const prefix = await createDevice({ orgId: orgA, siteId: siteA, hostname: 'srv-02-backup' });
    const exact = await createDevice({ orgId: orgA, siteId: siteA, hostname: 'SRV-02' });

    const first = await devicesFor(`/search?q=srv-02&orgId=${orgA}`);
    expect(first).toHaveLength(5);
    expect(first[0]!.id).toBe(exact.id);
    expect(first[1]!.id).toBe(prefix.id);
    // Then substring matches by name.
    expect(first.slice(2).map((r) => r.title)).toEqual(['a-srv-02', 'b-srv-02', 'c-srv-02']);

    // Same query, same answer.
    const second = await devicesFor(`/search?q=srv-02&orgId=${orgA}`);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
  });
});
