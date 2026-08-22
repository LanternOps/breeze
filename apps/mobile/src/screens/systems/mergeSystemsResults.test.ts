import { describe, it, expect } from 'vitest';

import {
  ALL_FAILED_MESSAGE,
  ORG_NAME_UNAVAILABLE,
  ORG_NAME_UNKNOWN,
  PARTIAL_FAILED_MESSAGE,
  mergeSystemsResults,
  rejectionReasons,
  resolveOrgName,
  type SystemsSlices,
} from './mergeSystemsResults';
import type { Alert, Device } from '../../services/api';

const device = (id: string) => ({ id, name: id } as unknown as Device);
const alert = (id: string) => ({ id } as unknown as Alert);

const ok = <T,>(value: T): PromiseSettledResult<T> => ({ status: 'fulfilled', value });
const bad = (reason: unknown): PromiseSettledResult<never> => ({ status: 'rejected', reason });

const previous: SystemsSlices = {
  summary: { online: 1 } as never,
  alerts: [alert('a-old')],
  activeAlerts: [alert('act-old')],
  devices: [device('d-old')],
  orgs: [{ id: 'o1', name: 'Org One' }],
};

const allOk = {
  summary: ok({ online: 2 } as never),
  alerts: ok([alert('a-new')]),
  activeAlerts: ok([alert('act-new')]),
  devices: ok([device('d1'), device('d2')]),
  orgs: ok([{ id: 'o2', name: 'Org Two' }]),
};

describe('mergeSystemsResults', () => {
  it('takes every fresh value when all four succeed, and reports no error', () => {
    const { slices, error, failed } = mergeSystemsResults(previous, allOk);
    expect(slices.devices).toHaveLength(2);
    expect(slices.alerts[0].id).toBe('a-new');
    expect(slices.activeAlerts[0].id).toBe('act-new');
    expect(slices.orgs[0].id).toBe('o2');
    expect(error).toBeNull();
    expect(failed).toEqual([]);
  });

  it('KEEPS devices that loaded when an unrelated call fails', () => {
    // The regression this exists for: under Promise.all a failing summary
    // discarded a perfectly good device list and the fleet rendered empty.
    const { slices, error, failed } = mergeSystemsResults(previous, {
      ...allOk,
      summary: bad(new Error('getMobileSummary failed: 500')),
    });
    expect(slices.devices).toHaveLength(2);
    expect(slices.alerts[0].id).toBe('a-new');
    expect(slices.summary).toEqual(previous.summary); // last-known retained
    expect(error).toBe(PARTIAL_FAILED_MESSAGE);
    expect(failed).toEqual(['summary']);
  });

  it('retains the previous value for each failed slice individually', () => {
    const { slices } = mergeSystemsResults(previous, {
      ...allOk,
      devices: bad(new Error('boom')),
      orgs: bad(new Error('boom')),
    });
    expect(slices.devices).toEqual(previous.devices);
    expect(slices.orgs).toEqual(previous.orgs);
    expect(slices.alerts[0].id).toBe('a-new'); // untouched by the failures
  });

  it('reports the all-failed message only when every call rejects', () => {
    const { slices, error, failed } = mergeSystemsResults(previous, {
      summary: bad(new Error('x')),
      alerts: bad(new Error('x')),
      activeAlerts: bad(new Error('x')),
      devices: bad(new Error('x')),
      orgs: bad(new Error('x')),
    });
    expect(error).toBe(ALL_FAILED_MESSAGE);
    expect(failed).toHaveLength(5);
    // Nothing is blanked even in the total-failure case — stale beats empty.
    expect(slices).toEqual(previous);
  });

  it('treats an empty successful result as real data, not a failure', () => {
    // A genuinely empty fleet must overwrite a previously non-empty one,
    // otherwise deleted devices linger forever.
    const { slices, error } = mergeSystemsResults(previous, {
      ...allOk,
      devices: ok([]),
    });
    expect(slices.devices).toEqual([]);
    expect(error).toBeNull();
  });
});

describe('rejectionReasons', () => {
  it('returns only the rejected reasons, in slice order', () => {
    const e1 = new Error('one');
    const e2 = new Error('two');
    expect(
      rejectionReasons({ ...allOk, summary: bad(e1), devices: bad(e2) })
    ).toEqual([e1, e2]);
  });

  it('is empty when nothing failed', () => {
    expect(rejectionReasons(allOk)).toEqual([]);
  });
});


describe('the two alert pages stay independent', () => {
  it('keeps RECENT data when only the active page fails, and vice versa', () => {
    // They serve different sections; one failing must not blank the other.
    const activeDown = mergeSystemsResults(previous, {
      ...allOk,
      activeAlerts: bad(new Error('boom')),
    });
    expect(activeDown.slices.alerts[0].id).toBe('a-new');
    expect(activeDown.slices.activeAlerts).toEqual(previous.activeAlerts);
    expect(activeDown.error).toBe(PARTIAL_FAILED_MESSAGE);

    const recentDown = mergeSystemsResults(previous, {
      ...allOk,
      alerts: bad(new Error('boom')),
    });
    expect(recentDown.slices.activeAlerts[0].id).toBe('act-new');
    expect(recentDown.slices.alerts).toEqual(previous.alerts);
  });
});

describe('resolveOrgName', () => {
  const orgs = [{ id: 'o1', name: 'Acme' }];

  it('returns the real name when the list has it', () => {
    expect(resolveOrgName(orgs, 'o1', false)).toEqual({ name: 'Acme', unavailable: false });
  });

  it('says "unknown" when the list loaded and simply does not contain the org', () => {
    const out = resolveOrgName(orgs, 'missing', false);
    expect(out.name).toBe(ORG_NAME_UNKNOWN);
    // Not a failure: the list is trustworthy, this org is genuinely not in it.
    expect(out.unavailable).toBe(false);
  });

  it('distinguishes "we never loaded the list" from "not in the list"', () => {
    // The #3753 regression: both used to render 'Unknown organization', so a
    // failed orgs slice produced rows indistinguishable from real data.
    const out = resolveOrgName([], 'o1', true);
    expect(out.name).toBe(ORG_NAME_UNAVAILABLE);
    expect(out.unavailable).toBe(true);
    expect(out.name).not.toBe(ORG_NAME_UNKNOWN);
  });

  it('prefers a resolved name even when another slice failed', () => {
    // orgs itself succeeded; a sibling failure must not degrade good labels.
    expect(resolveOrgName(orgs, 'o1', true)).toEqual({ name: 'Acme', unavailable: false });
  });
});
