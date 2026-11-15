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

import { selectNetworkExecutor, loadAssetSiteId, selectMonitorExecutor, ipv4Slash24Prefix } from './networkExecutorSelection';

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

describe('topology virtual-target monitor scope', () => {
  it('uses the explicit monitor site even without an inventory asset', async () => {
    selectResults = [[{agentId:'site-origin'}]];
    await expect(selectMonitorExecutor({orgId:'org-1',assetId:null,siteId:'site-a'})).resolves.toEqual({agentId:'site-origin'});
    expect(render(captured.wheres[0]).params).toContain('site-a');
  });
  it('fails closed when the stored site differs from the live asset site', async () => {
    selectResults = [[{siteId:'site-b'}]];
    await expect(selectMonitorExecutor({orgId:'org-1',assetId:'asset-1',siteId:'site-a'})).resolves.toEqual({error:'no_agent_in_site'});
    expect(captured.wheres).toHaveLength(1);
  });
});

describe('target-subnet executor preference', () => {
  it.each([
    ['10.10.178.1', '10.10.178.'],
    [' 192.168.001.1 ', '192.168.1.'],
    ['172.20.6.1', '172.20.6.'],
    ['172.32.0.1', null],
    ['8.8.8.8', null],
    ['256.1.1.1', null],
    ['10.10.178', null],
    ['gateway.local', null],
    ['fe80::1', null],
    ['', null],
    [null, null],
  ])('ipv4Slash24Prefix(%j) = %j', (target, want) => {
    expect(ipv4Slash24Prefix(target)).toBe(want);
  });

  it('prefers an on-subnet device for an IPv4 target, then falls back to any eligible device', async () => {
    selectResults = [[{ siteId: 'site-a' }], [{ agentId: 'nuc-on-lan' }]];
    await expect(selectMonitorExecutor({ orgId: 'org-1', assetId: 'asset-1', target: '10.10.178.1' }))
      .resolves.toEqual({ agentId: 'nuc-on-lan' });
    const preferred = render(captured.wheres[1]);
    expect(preferred.sql).toContain('exists (select 1 from device_network dn where dn.device_id = "devices"."id" and dn.ip_address like');
    expect(preferred.sql).toContain('"devices"."site_id" =');
    expect(preferred.params).toContain('10.10.178.%');
    expect(captured.wheres).toHaveLength(2);

    captured.wheres = [];
    selectResults = [[{ siteId: 'site-a' }], [], [{ agentId: 'roaming-laptop' }]];
    await expect(selectMonitorExecutor({ orgId: 'org-1', assetId: 'asset-1', target: '10.10.178.1' }))
      .resolves.toEqual({ agentId: 'roaming-laptop' });
    expect(render(captured.wheres[2]).sql).not.toContain('device_network');
    expect(render(captured.wheres[2]).sql).toContain('"devices"."site_id" =');

    captured.wheres = [];
    selectResults = [[{ siteId: 'site-a' }], [], []];
    await expect(selectMonitorExecutor({ orgId: 'org-1', assetId: 'asset-1', target: '10.10.178.1' }))
      .resolves.toEqual({ error: 'no_agent_in_site' });
  });

  it('adds no subnet query for a hostname target or a pinned revalidation', async () => {
    selectResults = [[{ agentId: 'a' }]];
    await selectNetworkExecutor({ orgId: 'org-1', siteId: 'site-1', targetIp: 'printer.local' });
    selectResults = [[{ agentId: 'a' }]];
    await selectNetworkExecutor({ orgId: 'org-1', siteId: 'site-1', targetIp: '10.10.178.1', agentId: 'a' });
    expect(captured.wheres).toHaveLength(2);
    for (const w of captured.wheres) expect(render(w).sql).not.toContain('device_network');
  });
});
