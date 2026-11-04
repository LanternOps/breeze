import { describe, expect, it } from 'vitest';
import { postLoginDestination, setupCompletionDestination } from './purchaseHandoff';

const selected = '/billing/plans?intent=cloud&offer=founding';
const legacySelected = '/billing/plans?catalog=launch-2026-10&capacity=250&billing=annual';

describe('purchase intent through login setup', () => {
  it('runs setup first and resumes the approved selection on completion', () => {
    const destination = postLoginDestination(true, selected);
    expect(destination).toBe(`/setup?next=${encodeURIComponent(selected)}`);
    expect(setupCompletionDestination(destination.slice('/setup'.length))).toBe(selected);
  });
  it('keeps ordinary login and no-selection setup behavior', () => {
    expect(postLoginDestination(false, selected)).toBe(selected);
    expect(postLoginDestination(true, '/devices')).toBe('/setup');
    expect(setupCompletionDestination('')).toBe('/');
  });
  it.each(['//evil.test', 'https://evil.test', '/billing/plans?capacity=250', '/billing/plans?catalog=launch-2026-10&capacity=150&billing=annual'])('does not resume malformed purchase destinations: %s', (next) => {
    expect(postLoginDestination(true, next)).toBe('/setup');
    expect(setupCompletionDestination(`?next=${encodeURIComponent(next)}`)).toBe('/');
  });
  it('strips unrelated parameters instead of carrying them through setup', () => {
    const target = postLoginDestination(true, `${selected}&redirect=//evil.test`);
    expect(target).toBe(`/setup?next=${encodeURIComponent(selected)}`);
    const legacy = postLoginDestination(true, `${legacySelected}&redirect=//evil.test`);
    expect(legacy).toBe(`/setup?next=${encodeURIComponent('/billing/plans?intent=cloud')}`);
  });
});

describe('signup intent through login setup', () => {
  const wisp = '/billing/plans?intent=wisp&offer=founding';
  it('resumes an intent destination after setup', () => {
    expect(postLoginDestination(true, wisp)).toBe(`/setup?next=${encodeURIComponent(wisp)}`);
    expect(setupCompletionDestination(`?next=${encodeURIComponent(wisp)}`)).toBe(wisp);
  });
  it('maps a legacy launch destination to the cloud intent', () => {
    const legacy = '/billing/plans?catalog=launch-2026-10&capacity=250&billing=annual';
    expect(postLoginDestination(true, legacy)).toBe(`/setup?next=${encodeURIComponent('/billing/plans?intent=cloud')}`);
  });
  it.each(['//evil.test', 'https://evil.test'])('stays same-origin: %s', (next) => {
    expect(postLoginDestination(true, next)).toBe('/setup');
  });
});
