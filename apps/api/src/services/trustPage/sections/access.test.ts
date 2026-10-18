import { describe, expect, it } from 'vitest';
import { resolveFrozenConfig, trustPublishedConfigSchema, type TrustPagePublicPayload } from '@breeze/shared';
import { buildAccessBlock } from './access';
import type { SectionBuildContext } from './types';

const DOC = '0b9a4f4e-3b8e-4f2a-9c51-7d1f2c0e9a11';
const W1_BASE = {
  hiddenControlIds: [], showPercentages: false, showDeviceCount: false, showManagedBy: true, searchIndexable: false,
  introHtml: null, websiteUrl: null, securityContactEmail: null, documentIds: [DOC],
};
const doc = (visibility: 'public' | 'gated'): TrustPagePublicPayload['documents'][number] => ({
  id: DOC, title: 'SOC 2', category: 'report', contentType: 'application/pdf', byteSize: 1, updatedAt: '2026-10-17T00:00:00.000Z', visibility,
});
const ctx = (config: Record<string, unknown>, documents: TrustPagePublicPayload['documents']): SectionBuildContext => ({
  page: {} as never, asOf: new Date(), partnerName: 'MSP', config: resolveFrozenConfig(trustPublishedConfigSchema.parse({ ...W1_BASE, ...config })), documents,
});

describe('buildAccessBlock', () => {
  it('a document published as gated opens the access flow with the frozen NDA text', () => {
    expect(buildAccessBlock(ctx({ documents: [{ id: DOC, visibility: 'gated' }], ndaText: 'Keep it private.' }, [doc('gated')])))
      .toEqual({ ndaText: 'Keep it private.' });
  });
  it('normalizes the NDA text: trimmed, and blank → null', () => {
    expect(buildAccessBlock(ctx({ documents: [{ id: DOC, visibility: 'gated' }], ndaText: '  Keep it private.\n ' }, [doc('gated')])))
      .toEqual({ ndaText: 'Keep it private.' });
    expect(buildAccessBlock(ctx({ documents: [{ id: DOC, visibility: 'gated' }], ndaText: '   ' }, [doc('gated')])))
      .toEqual({ ndaText: null });
  });
  it('no gated document → no access block', () => {
    expect(buildAccessBlock(ctx({ documents: [{ id: DOC, visibility: 'public' }], ndaText: 'x' }, [doc('public')]))).toBeNull();
  });
  it('a legacy (W1-frozen) config whose live link turned gated gets NO access block until republished', () => {
    // The document renders "Available on request" (the more restrictive visibility wins), but the request flow and
    // its NDA text are publisher-authored W2 content: they reach the public page only through a publish.
    expect(buildAccessBlock(ctx({}, [doc('gated')]))).toBeNull();
  });
  it('a W2 page whose frozen-public link turned gated live gets no access block either', () => {
    expect(buildAccessBlock(ctx({ documents: [{ id: DOC, visibility: 'public' }], ndaText: 'x' }, [doc('gated')]))).toBeNull();
  });
});
