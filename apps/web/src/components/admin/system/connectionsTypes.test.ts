import { describe, expect, it } from 'vitest';
import {
  CONNECTION_STATUSES,
  displayableValue,
  filterGroups,
  isProblemStatus,
  safeDocsUrl,
  type ConnectionGroupView,
  type ConnectionVarView,
} from './connectionsTypes';

describe('isProblemStatus', () => {
  it('treats misconfigured and required_missing as problems, enabled and disabled as not', () => {
    expect(CONNECTION_STATUSES.filter(isProblemStatus)).toEqual(['misconfigured', 'required_missing']);
  });
});

describe('displayableValue (client-side D2/D8 guard)', () => {
  const base: ConnectionVarView = { name: 'X', secret: false, set: true, value: 'smtp.example.test' };

  it('returns the value only for an explicit secret:false var that is set', () => {
    expect(displayableValue(base)).toBe('smtp.example.test');
  });

  it('never returns a value for a secret var, even if the payload wrongly carries one', () => {
    expect(displayableValue({ ...base, secret: true, value: 'CANARY-secret' })).toBeNull();
  });

  it('treats a missing or non-boolean secret flag as secret (default-deny)', () => {
    const noFlag = { name: 'X', set: true, value: 'CANARY-noflag' } as unknown as ConnectionVarView;
    const truthyString = { ...base, secret: 'false' } as unknown as ConnectionVarView;
    expect(displayableValue(noFlag)).toBeNull();
    expect(displayableValue(truthyString)).toBeNull();
  });

  it('returns null when the var is not set or the value is empty or absent', () => {
    expect(displayableValue({ ...base, set: false })).toBeNull();
    expect(displayableValue({ ...base, value: '' })).toBeNull();
    expect(displayableValue({ name: 'X', secret: false, set: true })).toBeNull();
  });

  it('refuses a non-secret value that carries URL userinfo', () => {
    expect(displayableValue({ ...base, value: 'postgres://app:CANARY-pw@db:5432/breeze' })).toBeNull();
    expect(displayableValue({ ...base, value: 'https://user@host.example' })).toBeNull();
    expect(displayableValue({ ...base, value: 'https://api.example.com/path' })).toBe('https://api.example.com/path');
  });
});

describe('filterGroups', () => {
  const groups: ConnectionGroupView[] = [
    {
      group: 'core',
      entries: [
        { id: 'database', label: 'PostgreSQL', status: 'enabled', vars: [] },
        { id: 'redis', label: 'Redis', status: 'required_missing', vars: [] },
      ],
    },
    { group: 'email', entries: [{ id: 'smtp', label: 'SMTP', status: 'misconfigured', vars: [] }] },
    { group: 'observability', entries: [{ id: 'sentry', label: 'Sentry', status: 'disabled', vars: [] }] },
    { group: 'billing', entries: [] },
  ];

  it('returns every non-empty group unchanged when not filtering', () => {
    expect(filterGroups(groups, false).map((g) => g.group)).toEqual(['core', 'email', 'observability']);
    expect(filterGroups(groups, false)[0].entries).toHaveLength(2);
  });

  it('keeps only problem entries and drops groups left empty when filtering', () => {
    const filtered = filterGroups(groups, true);
    expect(filtered.map((g) => g.group)).toEqual(['core', 'email']);
    expect(filtered[0].entries.map((e) => e.id)).toEqual(['redis']);
  });
});

describe('safeDocsUrl', () => {
  it('resolves W01 docs-site paths against the docs origin, keeping the anchor', () => {
    expect(safeDocsUrl('/deploy/environment/#database')).toBe('https://docs.breezermm.com/deploy/environment/#database');
    expect(safeDocsUrl('/deploy/turn-server/')).toBe('https://docs.breezermm.com/deploy/turn-server/');
  });

  it('accepts absolute https URLs on the docs origin only', () => {
    expect(safeDocsUrl('https://docs.breezermm.com/deploy/environment/')).toBe(
      'https://docs.breezermm.com/deploy/environment/',
    );
  });

  it('rejects missing, protocol-relative, non-rooted, non-https and script URLs', () => {
    expect(safeDocsUrl(undefined)).toBeNull();
    expect(safeDocsUrl(null)).toBeNull();
    expect(safeDocsUrl('')).toBeNull();
    expect(safeDocsUrl('//evil.example/deploy/')).toBeNull();
    expect(safeDocsUrl('/\\evil.example/deploy/')).toBeNull();
    expect(safeDocsUrl('deploy/environment/')).toBeNull();
    expect(safeDocsUrl('http://docs.breezermm.com/')).toBeNull();
    expect(safeDocsUrl('https://evil.example/phish')).toBeNull();
    expect(safeDocsUrl('https://docs.breezermm.com.evil.example/deploy/')).toBeNull();
    expect(safeDocsUrl('javascript:alert(1)')).toBeNull();
  });
});
