import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => ({ queue: [] as unknown[][] }));
vi.mock('../../../db', () => {
  const c: any = {};
  for (const m of ['select', 'from', 'where', 'orderBy']) c[m] = vi.fn(() => c);
  c.then = (r: any) => Promise.resolve(rows.queue.shift() ?? []).then(r);
  return { db: c };
});

import { resolveFrozenConfig, trustPublishedConfigSchema } from '@breeze/shared';
import { buildSubprocessors, freezeSubprocessors } from './subprocessors';
import type { SectionBuildContext } from './types';

const config = (over: Record<string, unknown> = {}) => resolveFrozenConfig(trustPublishedConfigSchema.parse({
  hiddenControlIds: [], showPercentages: false, showDeviceCount: false, showManagedBy: true, searchIndexable: false,
  introHtml: null, websiteUrl: null, securityContactEmail: null, documentIds: [], ...over,
}));
const ctx = (over: Record<string, unknown> = {}): SectionBuildContext => ({ page: { id: 'pg' } as never, asOf: new Date(), partnerName: 'MSP', config: config(over), documents: [] });

describe('freezeSubprocessors', () => {
  beforeEach(() => { rows.queue = []; });
  it('copies the stored rows in sort order, content only (no ids, source or sourceKey)', async () => {
    rows.queue = [[
      { id: 'x', name: 'A', purpose: 'P', location: 'US', websiteUrl: 'https://a.example', source: 'manual', sourceKey: null, sortOrder: 0 },
      { id: 'y', name: 'B', purpose: 'Q', location: null, websiteUrl: 'http://bad.example', source: 'backup', sourceKey: 'backup:b', sortOrder: 1 },
    ]];
    const out = await freezeSubprocessors({ page: { id: 'pg' } as never, asOf: new Date() });
    expect(out).toEqual([
      { name: 'A', purpose: 'P', location: 'US', websiteUrl: 'https://a.example', sortOrder: 0 },
      { name: 'B', purpose: 'Q', location: null, websiteUrl: null, sortOrder: 1 },
    ]);
  });
});

describe('buildSubprocessors', () => {
  it('maps the frozen config in sortOrder and re-validates websites as https', () => {
    const out = buildSubprocessors(ctx({ subprocessors: [
      { name: 'B', purpose: 'Q', location: null, websiteUrl: 'https://b.example', sortOrder: 1 },
      { name: 'A', purpose: 'P', location: 'US', websiteUrl: 'https://a.example', sortOrder: 0 },
    ] }));
    expect(out).toEqual([
      { name: 'A', purpose: 'P', location: 'US', websiteUrl: 'https://a.example' },
      { name: 'B', purpose: 'Q', location: null, websiteUrl: 'https://b.example' },
    ]);
  });
  it('nulls a non-https website that slipped into a stored config', () => {
    const c = ctx();
    (c.config as { subprocessors: unknown }).subprocessors = [{ name: 'A', purpose: 'P', location: null, websiteUrl: 'javascript:alert(1)', sortOrder: 0 }];
    expect(buildSubprocessors(c)[0]!.websiteUrl).toBeNull();
  });
  it('is empty for a legacy config', () => {
    expect(buildSubprocessors(ctx())).toEqual([]);
  });
});
