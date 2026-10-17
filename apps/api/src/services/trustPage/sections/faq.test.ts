import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => ({ queue: [] as unknown[][] }));
vi.mock('../../../db', () => {
  const c: any = {};
  for (const m of ['select', 'from', 'where', 'orderBy']) c[m] = vi.fn(() => c);
  c.then = (r: any) => Promise.resolve(rows.queue.shift() ?? []).then(r);
  return { db: c };
});

import { resolveFrozenConfig, trustPublishedConfigSchema } from '@breeze/shared';
import { buildFaq, freezeFaq } from './faq';
import type { SectionBuildContext } from './types';

const config = (over: Record<string, unknown> = {}) => resolveFrozenConfig(trustPublishedConfigSchema.parse({
  hiddenControlIds: [], showPercentages: false, showDeviceCount: false, showManagedBy: true, searchIndexable: false,
  introHtml: null, websiteUrl: null, securityContactEmail: null, documentIds: [], ...over,
}));
const ctx = (over: Record<string, unknown> = {}): SectionBuildContext => ({ page: { id: 'pg' } as never, asOf: new Date(), partnerName: 'MSP', config: config(over), documents: [] });

describe('freezeFaq', () => {
  beforeEach(() => { rows.queue = []; });
  it('copies question and answer in sort order and drops an answer over the cap', async () => {
    rows.queue = [[
      { question: 'Q1 long enough', answerHtml: '<p>A1</p>', sortOrder: 0 },
      { question: 'Q2 long enough', answerHtml: `<p>${'x'.repeat(16_001)}</p>`, sortOrder: 1 },
      { question: 'Q3 long enough', answerHtml: '<p>A3</p>', sortOrder: 2 },
    ]];
    const out = await freezeFaq({ page: { id: 'pg' } as never, asOf: new Date() });
    expect(out).toEqual([
      { question: 'Q1 long enough', answerHtml: '<p>A1</p>' },
      { question: 'Q3 long enough', answerHtml: '<p>A3</p>' },
    ]);
  });
});

describe('buildFaq', () => {
  it('re-sanitizes a hostile answer in the frozen config', () => {
    const out = buildFaq(ctx({ faq: [{ question: 'Is it safe?', answerHtml: '<p onclick="x()">Yes</p><script>alert(1)</script><img src=x onerror=alert(1)>' }] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.answerHtml).toContain('Yes');
    expect(out[0]!.answerHtml).not.toMatch(/script|onclick|onerror/i);
  });
  it('drops an answer over the cap with a warning instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = ctx();
    (c.config as { faq: unknown }).faq = [{ question: 'Too long?', answerHtml: `<p>${'x'.repeat(16_001)}</p>` }, { question: 'Fine?', answerHtml: '<p>ok</p>' }];
    expect(buildFaq(c).map((i) => i.question)).toEqual(['Fine?']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('is empty for a legacy config', () => {
    expect(buildFaq(ctx())).toEqual([]);
  });
});
