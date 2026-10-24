import { describe, expect, it } from 'vitest';
import { encodePatchesHash, mergePatchesHash, parsePatchesHash } from './patchesHash';

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
