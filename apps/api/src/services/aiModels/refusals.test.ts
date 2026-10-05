import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ getEffectiveAssignment: vi.fn(), resolveModel: vi.fn(), listOfferings: vi.fn() }));
vi.mock('./assignments', () => ({ getEffectiveAssignment: m.getEffectiveAssignment }));
vi.mock('./resolveModel', () => ({ resolveModel: m.resolveModel }));
vi.mock('./offerings', () => ({ listOfferings: m.listOfferings }));

import { REFUSAL_DOCS_URL, listRefusalAlternatives, refusalHeadline, refusalMessageText } from './refusals';

beforeEach(() => vi.clearAllMocks());

describe('refusal text', () => {
  it('names the category', () => {
    expect(refusalHeadline('cyber')).toBe('The model declined this request (category: cyber).');
  });
  it('a null category reads "unspecified", never blank', () => {
    expect(refusalHeadline(null)).toBe('The model declined this request (category: unspecified).');
  });
  it('lists alternatives and always links the admin docs', () => {
    expect(refusalMessageText('cyber', [{ offeringId: 'a', displayName: 'Opus 5.5' }, { offeringId: 'b', displayName: 'Haiku 4.5' }]))
      .toBe([
        'The model declined this request (category: cyber).',
        'You can retry with another model: Opus 5.5, Haiku 4.5.',
        `An administrator can configure a refusal fallback model: ${REFUSAL_DOCS_URL}`,
      ].join('\n\n'));
    expect(refusalMessageText(null, [])).toContain(REFUSAL_DOCS_URL);
  });
});

describe('listRefusalAlternatives', () => {
  it('offers only eligible permitted offerings, excluding the one that refused', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ defaultOfferingId: 'a', defaultSource: 'partner', permitted: { kind: 'list', offeringIds: ['a', 'b', 'c'] }, allowUserChoice: true, options: {} });
    m.resolveModel.mockImplementation(async ({ requested }: { requested: { offeringId: string } }) =>
      requested.offeringId === 'c'
        ? { ok: false, reason: 'permission_required' }
        : { ok: true, offering: { id: requested.offeringId, displayName: `M-${requested.offeringId}` } });
    expect(await listRefusalAlternatives({ partnerId: 'p', orgId: 'o', userId: 'u', surface: 'chat', excludeOfferingId: 'a' }))
      .toEqual([{ offeringId: 'b', displayName: 'M-b' }]);
    expect(m.resolveModel).toHaveBeenCalledWith(expect.objectContaining({ requested: { offeringId: 'b', origin: 'user' } }));
  });

  it('offers nothing when the user may not choose', async () => {
    m.getEffectiveAssignment.mockResolvedValue({ defaultOfferingId: 'a', defaultSource: 'partner', permitted: { kind: 'all' }, allowUserChoice: false, options: {} });
    expect(await listRefusalAlternatives({ partnerId: 'p', orgId: 'o', userId: 'u', surface: 'chat', excludeOfferingId: 'a' })).toEqual([]);
    expect(m.resolveModel).not.toHaveBeenCalled();
  });
});
