import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

let selectResults: unknown[][] = [];
const captured: { wheres: unknown[] } = { wheres: [] };

vi.mock('../db', () => {
  const chain = () => {
    const rows = selectResults.shift() ?? [];
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.where = (condition: unknown) => { captured.wheres.push(condition); return c; };
    c.limit = () => Promise.resolve(rows);
    c.then = (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve(rows).then(ok, err);
    return c;
  };
  return { db: { select: () => chain() } };
});

import { selectNetworkExecutor, loadAssetSiteId, selectMonitorExecutor } from './networkExecutorSelection';

const dialect = new PgDialect();
const render = (v: unknown) => dialect.sqlToQuery(v as SQL);

beforeEach(() => { selectResults = []; captured.wheres = []; });

describe('selectNetworkExecutor', () => {
  it('picks an online agent in the asset site', async () => {
    selectResults = [[{ agentId: 'agent-site' }]];
    await expect(selectNetworkExecutor({ orgId: 'org-1', siteId: 'site-1' })).resolves.toEqual({ agentId: 'agent-site' });
    expect(render(captured.wheres[0]).sql).toContain('site_id');
  });

  it('NEVER crosses the site boundary when the site has no online agent (SR5-08)', async () => {
    selectResults = [[]];
    await expect(selectNetworkExecutor({ orgId: 'org-1', siteId: 'site-1' })).resolves.toEqual({ error: 'no_agent_in_site' });
    // Exactly one query: there is no org-wide second attempt to fall through to.
    expect(captured.wheres).toHaveLength(1);
  });

  it('excludes ephemeral Quick Support devices on both branches', async () => {
    selectResults = [[{ agentId: 'a' }]];
    await selectNetworkExecutor({ orgId: 'org-1', siteId: 'site-1' });
    expect(render(captured.wheres[0]).sql).toContain('is_ephemeral');

    captured.wheres = [];
    selectResults = [[{ agentId: 'b' }]];
    await selectNetworkExecutor({ orgId: 'org-1', siteId: null });
    expect(render(captured.wheres[0]).sql).toContain('is_ephemeral');
  });

  it('selects org-wide for an unbound monitor', async () => {
    selectResults = [[{ agentId: 'agent-org' }]];
    await expect(selectNetworkExecutor({ orgId: 'org-1', siteId: null })).resolves.toEqual({ agentId: 'agent-org' });
    expect(render(captured.wheres[0]).sql).not.toContain('site_id');
  });

  it('honours restrictToSiteIds on the org-wide branch', async () => {
    selectResults = [[{ agentId: 'agent-allowed' }]];
    await selectNetworkExecutor({ orgId: 'org-1', siteId: null, restrictToSiteIds: ['site-a', 'site-b'] });
    const { sql, params } = render(captured.wheres[0]);
    expect(sql).toContain('site_id');
    expect(params).toContain('site-a');
  });

  it('refuses immediately when restrictToSiteIds is empty', async () => {
    await expect(selectNetworkExecutor({ orgId: 'org-1', siteId: null, restrictToSiteIds: [] }))
      .resolves.toEqual({ error: 'no_agent_in_site' });
    expect(captured.wheres).toHaveLength(0);
  });
});

describe('loadAssetSiteId', () => {
  it('scopes the lookup by org', async () => {
    selectResults = [[{ siteId: 'site-9' }]];
    await expect(loadAssetSiteId('org-1', 'asset-1')).resolves.toBe('site-9');
    const { sql } = render(captured.wheres[0]);
    expect(sql).toContain('org_id');
  });

  it('returns null when the asset is not in the org', async () => {
    selectResults = [[]];
    await expect(loadAssetSiteId('org-1', 'asset-1')).resolves.toBeNull();
  });
});


describe('selectMonitorExecutor shared manual/scheduled policy', () => {
  it.each([{ assetRows: [] }, { assetRows: [{ siteId: null }] }])('never turns an unresolved bound asset into an org-wide monitor (%j)', async ({ assetRows }) => {
    selectResults = [assetRows];
    await expect(selectMonitorExecutor({ orgId: 'org-1', assetId: 'asset-1' }))
      .resolves.toEqual({ error: 'no_agent_in_site' });
    expect(captured.wheres).toHaveLength(1);
  });

  it.each([{ allowedSiteIds: [] }, { allowedSiteIds: ['site-b'] }])('denies a bound site outside caller authorization %j', async ({ allowedSiteIds }) => {
    selectResults = [[{ siteId: 'site-a' }]];
    await expect(selectMonitorExecutor({ orgId: 'org-1', assetId: 'asset-1' }, { allowedSiteIds }))
      .resolves.toEqual({ error: 'site_access_denied' });
    expect(captured.wheres).toHaveLength(1);
  });

  it('requires unrestricted site authorization for genuinely unbound monitors', async () => {
    await expect(selectMonitorExecutor({ orgId: 'org-1', assetId: null }, { allowedSiteIds: ['site-a'] }))
      .resolves.toEqual({ error: 'site_access_denied' });
    expect(captured.wheres).toHaveLength(0);
  });

  it('rechecks the exact executor against org, site, status and ephemeral predicates', async () => {
    selectResults = [[{ siteId: 'site-a' }], []];
    await expect(selectMonitorExecutor({ orgId: 'org-1', assetId: 'asset-1' }, { agentId: 'original-agent', allowedSiteIds: ['site-a'] }))
      .resolves.toEqual({ error: 'no_agent_in_site' });
    const query = render(captured.wheres[1]);
    expect(query.sql).toContain('"devices"."org_id" =');
    expect(query.sql).toContain('"devices"."site_id" =');
    expect(query.sql).toContain('"devices"."agent_id" =');
    expect(query.sql).toContain('"devices"."status" =');
    expect(query.sql).toContain('"devices"."agent_token_suspended_at" is null');
    expect(query.sql).toContain('"devices"."is_ephemeral" =');
    expect(query.params).toEqual(['org-1', false, 'online', 'original-agent', 'site-a']);
    expect(captured.wheres).toHaveLength(2);
  });
});
