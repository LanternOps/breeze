import { describe, expect, it } from 'vitest';
import { encodePatchesHash, mergePatchesHash, orgAgnosticPatchesHash, parsePatchesHash } from './patchesHash';

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

  it('keeps nothing for an empty or unrecognised hash', () => {
    expect(orgAgnosticPatchesHash('')).toBeNull();
    expect(orgAgnosticPatchesHash('#')).toBeNull();
    expect(orgAgnosticPatchesHash('#dev-1')).toBeNull();
  });
});
