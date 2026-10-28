import { describe, expect, it } from 'vitest';
import type { InheritanceFieldDto } from '@breeze/shared';
import { i18n } from '@/lib/i18n';
import { inheritanceLineCopy, LINE_KEYS, lineText } from './inheritanceLineCopy';

const t = i18n.getFixedT('en', 'settings');

function field(over: Partial<InheritanceFieldDto>): InheritanceFieldDto {
  return {
    id: 'x', kind: 'locks', partnerSet: true, inForce: true, platformDefault: null, sealed: false,
    counts: { ownValue: 0, overrides: 0, shadowed: 0 }, ...over,
  };
}

const text = (f: InheritanceFieldDto, orgCount = 42, opts: Partial<Parameters<typeof inheritanceLineCopy>[2]> = {}) =>
  lineText(inheritanceLineCopy(f, orgCount, { draftDirty: false, platformDefaultLabel: null, ...opts }), t);

describe('inheritanceLineCopy: one case per spec §5.4 row', () => {
  it('locks, set, 3 shadowed', () => {
    const f = field({ counts: { ownValue: 3, overrides: 0, shadowed: 3 } });
    expect(text(f)).toBe('Applies to all 42 orgs · 3 had their own value');
    expect(inheritanceLineCopy(f, 42, { draftDirty: false, platformDefaultLabel: null }).clauses.find(c => c.drill)?.drill).toBe('shadowed');
  });

  it('locks, set, nothing shadowed', () => {
    expect(text(field({}))).toBe('Applies to all 42 orgs');
  });

  it('locks, blank', () => {
    const f = field({ partnerSet: false, inForce: false, counts: { ownValue: 5, overrides: 0, shadowed: 0 } });
    expect(text(f, 42, { platformDefaultLabel: '480 min' }))
      .toBe('Not set. 5 of 42 orgs set their own · the rest use the platform default (480 min)');
  });

  it('locks, blank, no org sets its own', () => {
    const f = field({ partnerSet: false, inForce: false });
    expect(text(f, 42, { platformDefaultLabel: 'Off' })).toBe('Not set. Orgs use the platform default (Off)');
    expect(text(f)).toBe('Not set. No org has its own value');
  });

  it('overridable, set', () => {
    const f = field({ kind: 'overridable', counts: { ownValue: 6, overrides: 4, shadowed: 0 } });
    expect(text(f)).toBe('Default for 42 orgs · 4 override');
  });

  it('overridable, blank', () => {
    const f = field({ kind: 'overridable', partnerSet: false, inForce: false, counts: { ownValue: 4, overrides: 0, shadowed: 0 } });
    expect(text(f, 42, { platformDefaultLabel: '7 days' })).toBe('Not set. Orgs use the platform default (7 days) · 4 set their own');
  });

  it('locks + conditional, set but not in force', () => {
    const f = field({ qualifier: 'conditional', partnerSet: true, inForce: false, sealed: true, counts: { ownValue: 6, overrides: null, shadowed: 0 } });
    expect(text(f)).toBe('Not in force (destination disabled). Orgs use their own destination · 6 have one');
  });

  it('locks + conditional, in force, behaves like a set lock', () => {
    const f = field({ qualifier: 'conditional', sealed: true, counts: { ownValue: 2, overrides: null, shadowed: 2 } });
    expect(text(f)).toBe('Applies to all 42 orgs · 2 had their own value');
  });

  it('overridable + cap', () => {
    const f = field({ kind: 'overridable', qualifier: 'cap', counts: { ownValue: 5, overrides: 4, shadowed: 0, clamped: 2 } });
    expect(text(f)).toBe('Default for 42 orgs · 4 override · 2 are clamped to your ceiling');
    expect(inheritanceLineCopy(f, 42, { draftDirty: false, platformDefaultLabel: null }).clauses.map(c => c.drill ?? null))
      .toEqual([null, 'overrides', 'clamped']);
  });

  it('partnerOnly, set and blank', () => {
    const set = field({ kind: 'partnerOnly', counts: null });
    expect(text(set)).toBe('Applies to all 42 orgs');
    const blank = field({ kind: 'partnerOnly', partnerSet: false, inForce: false, counts: null });
    expect(text(blank, 42, { platformDefaultLabel: 'On' })).toBe('Platform default (On) applies to all orgs');
    expect(text(blank)).toBe('Not set. The platform default applies to all orgs');
  });
});

describe('inheritanceLineCopy: states and edge cases', () => {
  it('draft shows the Saved value prefix', () => {
    const f = field({ kind: 'overridable', counts: { ownValue: 4, overrides: 4, shadowed: 0 } });
    expect(text(f, 42, { draftDirty: true })).toBe('Saved value: Default for 42 orgs · 4 override');
  });

  it('a secret overridable field says "set their own", never "override"', () => {
    const f = field({ kind: 'overridable', sealed: true, counts: { ownValue: 2, overrides: null, shadowed: 0 } });
    expect(text(f)).toBe('Default for 42 orgs · 2 set their own');
    expect(text(f)).not.toMatch(/override/);
  });

  it('byConsumer renders one clause per consumer', () => {
    const f = field({
      kind: 'overridable',
      byConsumer: [
        { consumerId: 'reports', counts: { ownValue: 0, overrides: 0, shadowed: 0 } },
        { consumerId: 'documents', counts: { ownValue: 3, overrides: 3, shadowed: 0 } },
      ],
    });
    expect(text(f, 42, { consumerLabels: { reports: 'Reports', documents: 'Documents' } }))
      .toBe('Reports: applies to all orgs · Documents: 3 orgs use their own value');
  });

  it('singular forms', () => {
    const f = field({ counts: { ownValue: 1, overrides: 0, shadowed: 1 } });
    expect(text(f, 1)).toBe('Applies to 1 org · 1 had its own value');
  });

  it('no orgs yet', () => {
    expect(text(field({}), 0)).toBe('No organizations yet');
  });

  it('unclassified has no line', () => {
    expect(inheritanceLineCopy(field({ kind: 'unclassified', counts: null }), 42, { draftDirty: false, platformDefaultLabel: null }).clauses).toEqual([]);
  });

  it('a field without org counts still states its reach', () => {
    expect(text(field({ counts: null }))).toBe('Applies to all 42 orgs');
    expect(text(field({ kind: 'overridable', counts: null }))).toBe('Default for 42 orgs');
  });

  it('every key the copy can produce exists in en, with _one/_other where plural', () => {
    for (const key of LINE_KEYS) {
      const plural = i18n.exists(`settings:${key}_one`) && i18n.exists(`settings:${key}_other`);
      expect(plural || i18n.exists(`settings:${key}`), key).toBe(true);
    }
  });
});
