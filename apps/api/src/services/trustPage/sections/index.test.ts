import { describe, expect, it, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  freezeDeclarationIds: vi.fn(), buildDeclaredControls: vi.fn(),
  freezeSubprocessors: vi.fn(), buildSubprocessors: vi.fn(),
  freezeFaq: vi.fn(), buildFaq: vi.fn(),
  buildHistory: vi.fn(), resolveFrameworkView: vi.fn(), buildAccessBlock: vi.fn(),
}));
vi.mock('./declarations', () => ({ freezeDeclarationIds: m.freezeDeclarationIds, buildDeclaredControls: m.buildDeclaredControls }));
vi.mock('./subprocessors', () => ({ freezeSubprocessors: m.freezeSubprocessors, buildSubprocessors: m.buildSubprocessors }));
vi.mock('./faq', () => ({ freezeFaq: m.freezeFaq, buildFaq: m.buildFaq }));
vi.mock('./history', () => ({ buildHistory: m.buildHistory }));
vi.mock('./frameworks', () => ({ resolveFrameworkView: m.resolveFrameworkView }));
vi.mock('./access', () => ({ buildAccessBlock: m.buildAccessBlock }));

import { trustPublishedConfigSchema, resolveFrozenConfig } from '@breeze/shared';
import { buildSections, freezeSections } from './index';
import type { SectionBuildContext } from './types';

const page = { id: 'pg', orgId: 'o', partnerId: 'p' } as never;
const config = (over: Record<string, unknown> = {}) => resolveFrozenConfig(trustPublishedConfigSchema.parse({
  hiddenControlIds: [], showPercentages: false, showDeviceCount: false, showManagedBy: true, searchIndexable: false,
  introHtml: null, websiteUrl: null, securityContactEmail: null, documentIds: [], frameworkView: ['essential_eight'], ...over,
}));
const ctx = (over: Record<string, unknown> = {}): SectionBuildContext => ({ page, asOf: new Date(), partnerName: 'MSP', config: config(over), documents: [] });

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.buildDeclaredControls.mockResolvedValue(['DECL']);
  m.buildSubprocessors.mockReturnValue(['SUB']);
  m.buildFaq.mockReturnValue(['FAQ']);
  m.buildHistory.mockResolvedValue(['HIST']);
  m.resolveFrameworkView.mockReturnValue(['FW']);
  m.buildAccessBlock.mockReturnValue({ ndaText: 'NDA' });
});

describe('buildSections', () => {
  it('returns each section module value under its payload key', async () => {
    const out = await buildSections(ctx({ showHistory: true }));
    expect(out).toEqual({ declaredControls: ['DECL'], subprocessors: ['SUB'], faq: ['FAQ'], history: ['HIST'], frameworks: ['FW'], access: { ndaText: 'NDA' } });
    expect(m.resolveFrameworkView).toHaveBeenCalledWith(['essential_eight']);
  });

  it('a page whose frozen config did not opt into history renders none, without calling the history module', async () => {
    const out = await buildSections(ctx({ showHistory: false }));
    expect(out.history).toEqual([]);
    expect(m.buildHistory).not.toHaveBeenCalled();
  });
});

describe('freezeSections', () => {
  it('merges the three freezes', async () => {
    m.freezeDeclarationIds.mockResolvedValue(['d1']);
    m.freezeSubprocessors.mockResolvedValue([{ name: 'V', purpose: 'P', location: null, websiteUrl: null, sortOrder: 0 }]);
    m.freezeFaq.mockResolvedValue([{ question: 'Q?', answerHtml: '<p>A</p>' }]);
    const out = await freezeSections({ page, asOf: new Date() });
    expect(out).toEqual({
      declarationIds: ['d1'],
      subprocessors: [{ name: 'V', purpose: 'P', location: null, websiteUrl: null, sortOrder: 0 }],
      faq: [{ question: 'Q?', answerHtml: '<p>A</p>' }],
    });
  });
});
