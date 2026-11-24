import { describe, expect, it, vi } from 'vitest';
import { featureEditAction, featureEditProps } from './featureEditAction';
import type { FeatureLink } from './types';

const link = (id: string): FeatureLink => ({ id, featureType: 'pam', featurePolicyId: null, inlineSettings: {} });

describe('featureEditAction (#12263)', () => {
  it('featureEditAction offers Reset only when the parent has the feature', () => {
    expect(featureEditAction(link('own'), link('parent'))).toBe('reset_to_parent');
    // A child policy whose parent lacks the feature: Remove, never Reset.
    expect(featureEditAction(link('own'), undefined)).toBe('remove');
    // Nothing of its own: no footer action (inherited or not set).
    expect(featureEditAction(undefined, link('parent'))).toBeNull();
    expect(featureEditAction(undefined, undefined)).toBeNull();
  });

  it('featureEditProps hands the shell exactly one of the two handlers', () => {
    const remove = vi.fn();
    const reset = vi.fn();
    expect(featureEditProps(link('own'), undefined, { remove, reset })).toEqual({ onRemove: remove });
    expect(featureEditProps(link('own'), link('parent'), { remove, reset })).toEqual({ onRevert: reset });
    expect(featureEditProps(undefined, link('parent'), { remove, reset })).toEqual({});
    // A tab whose reset is the same delete passes only `remove`.
    expect(featureEditProps(link('own'), link('parent'), { remove })).toEqual({ onRevert: remove });
  });
});
