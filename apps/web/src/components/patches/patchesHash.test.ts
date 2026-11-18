import { describe, expect, it } from 'vitest';
import {
  encodePatchesHash,
  mergePatchesHash,
  mergeVendorUpdatesHash,
  orgAgnosticPatchesHash,
  parsePatchesHash,
} from './patchesHash';

describe('parsePatchesHash', () => {
  it('reads the compliance status with or without the tab token', () => {
    expect(parsePatchesHash('#compliance&status=failed')).toMatchObject({ tab: 'compliance', status: 'failed' });
    expect(parsePatchesHash('status=failed')).toMatchObject({ tab: null, status: 'failed' });
  });

  it.each(['needs-patches', 'compliant', 'failed', 'critical', 'reboot', 'third-party'] as const)(
    'accepts status=%s',
    (status) => {
      expect(parsePatchesHash(`#compliance&status=${status}`).status).toBe(status);
    },
  );

  it('ignores an unknown status and unknown keys', () => {
    expect(parsePatchesHash('#compliance&status=bogus&foo=1').status).toBeNull();
    expect(parsePatchesHash('#status=all').status).toBeNull();
  });

  it('keeps the legacy tab hashes resolving', () => {
    expect(parsePatchesHash('#patches')).toMatchObject({ tab: 'patches', selection: null, status: null });
    expect(parsePatchesHash('#patches/abc')).toMatchObject({ tab: 'patches', selection: 'abc' });
    expect(parsePatchesHash('#rings').tab).toBe('rings');
    expect(parsePatchesHash('#jobs').tab).toBe('jobs');
    expect(parsePatchesHash('').tab).toBeNull();
  });
});

describe('encodePatchesHash', () => {
  it('builds the compliance tab hash with a status', () => {
    expect(encodePatchesHash({ status: 'compliant' })).toBe('#compliance&status=compliant');
    expect(encodePatchesHash({ status: 'needs-patches' })).toBe('#compliance&status=needs-patches');
  });

  it('round-trips through the parser', () => {
    expect(parsePatchesHash(encodePatchesHash({ status: 'critical' }))).toMatchObject({ tab: 'compliance', status: 'critical' });
  });

  it('is the bare compliance tab without a status', () => {
    expect(encodePatchesHash({})).toBe('#compliance');
  });
});

describe('mergePatchesHash', () => {
  it('rewrites only status and keeps the tab and unknown keys', () => {
    expect(mergePatchesHash('#compliance&foo=1&status=failed', { status: 'critical' })).toBe('#compliance&foo=1&status=critical');
    expect(mergePatchesHash('', { status: 'failed' })).toBe('#status=failed');
  });

  it('removes status for all', () => {
    expect(mergePatchesHash('#compliance&status=failed', { status: 'all' })).toBe('#compliance');
    expect(mergePatchesHash('#status=failed', { status: 'all' })).toBe('');
  });
});

// #10083: what the Patches page keeps across a header org switch — the tab and
// the compliance status filter, never a patch id or a key it does not own.
describe('orgAgnosticPatchesHash', () => {
  it.each([
    ['#compliance&status=critical', 'compliance&status=critical'],
    ['status=critical', 'compliance&status=critical'],
    ['#compliance', 'compliance'],
    ['#rings', 'rings'],
    ['#jobs', 'jobs'],
    ['#patches', 'patches'],
  ])('keeps %s as %s', (hash, kept) => {
    expect(orgAgnosticPatchesHash(hash)).toBe(kept);
  });

  it('drops the patch id a details drawer selected', () => {
    expect(orgAgnosticPatchesHash('#patches/3f0c2b7e-1111-4111-8111-111111111111')).toBe('patches');
  });

  it('drops keys it does not own and a status it does not know', () => {
    expect(orgAgnosticPatchesHash('#compliance&status=failed&device=dev-1')).toBe('compliance&status=failed');
    expect(orgAgnosticPatchesHash('#compliance&status=bogus')).toBe('compliance');
  });

  it('keeps the status only on the compliance tab, where it is a filter', () => {
    expect(orgAgnosticPatchesHash('#patches/abc-123&status=failed')).toBe('patches');
    expect(orgAgnosticPatchesHash('#rings&status=failed')).toBe('rings');
  });

  it('keeps nothing for an empty or unrecognised hash', () => {
    expect(orgAgnosticPatchesHash('')).toBeNull();
    expect(orgAgnosticPatchesHash('#')).toBeNull();
    expect(orgAgnosticPatchesHash('#dev-1')).toBeNull();
  });
});

describe('the Vendor updates tab (#11074)', () => {
  it('reads the tab, its state filter and its vendor filter', () => {
    expect(parsePatchesHash('#vendor-updates')).toMatchObject({ tab: 'vendor-updates', vendorState: null, vendorLane: null });
    expect(parsePatchesHash('#vendor-updates&state=reboot_overdue&lane=hp')).toMatchObject({
      tab: 'vendor-updates',
      vendorState: 'reboot_overdue',
      vendorLane: 'hp',
    });
  });

  it('ignores a value outside the vocabulary', () => {
    expect(parsePatchesHash('#vendor-updates&state=bogus&lane=acer')).toMatchObject({ vendorState: null, vendorLane: null });
  });

  it('writes its own keys and keeps the rest', () => {
    expect(mergeVendorUpdatesHash('#vendor-updates', { state: 'overdue' })).toBe('#vendor-updates&state=overdue');
    expect(mergeVendorUpdatesHash('#vendor-updates&state=overdue', { lane: 'dell' })).toBe('#vendor-updates&state=overdue&lane=dell');
    expect(mergeVendorUpdatesHash('#vendor-updates&state=overdue&lane=dell', { state: 'all' })).toBe('#vendor-updates&lane=dell');
    expect(mergeVendorUpdatesHash('#vendor-updates&lane=dell', { lane: 'all' })).toBe('#vendor-updates');
    expect(mergeVendorUpdatesHash('#vendor-updates&foo=1', { state: 'failing' })).toBe('#vendor-updates&foo=1&state=failing');
  });

  it('keeps the tab and its filters across an org switch: a fixed vocabulary means the same in every org', () => {
    expect(orgAgnosticPatchesHash('#vendor-updates&state=overdue&lane=dell')).toBe('vendor-updates&state=overdue&lane=dell');
    expect(orgAgnosticPatchesHash('#vendor-updates')).toBe('vendor-updates');
    expect(orgAgnosticPatchesHash('#vendor-updates&foo=1')).toBe('vendor-updates');
  });

  it('its filters mean nothing on another tab', () => {
    expect(orgAgnosticPatchesHash('#compliance&state=overdue')).toBe('compliance');
  });

  it('leaves the compliance status alone', () => {
    expect(parsePatchesHash('#compliance&status=failed').vendorState).toBeNull();
    expect(mergePatchesHash('#compliance', { status: 'failed' })).toBe('#compliance&status=failed');
  });
});
