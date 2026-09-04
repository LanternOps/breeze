import { describe, expect, it } from 'vitest';
import { readOrgIdFromHash } from './orgHash';

const ORG = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('readOrgIdFromHash (#3205 W06)', () => {
  it('reads the uuid from either fragment order and tolerates a leading #', () => {
    expect(readOrgIdFromHash(`#orgId=${ORG}&filtersV2=abc`)).toBe(ORG);
    expect(readOrgIdFromHash(`filtersV2=abc&orgId=${ORG}`)).toBe(ORG);
    expect(readOrgIdFromHash(`#deviceClass=agent&orgId=${ORG}&filtersV2=abc`)).toBe(ORG);
  });
  it('ignores a missing key, an empty value and anything that is not a uuid', () => {
    expect(readOrgIdFromHash('')).toBeNull();
    expect(readOrgIdFromHash('#filtersV2=abc')).toBeNull();
    expect(readOrgIdFromHash('#orgId=')).toBeNull();
    expect(readOrgIdFromHash('#orgId=not-a-uuid')).toBeNull();
    expect(readOrgIdFromHash("#orgId='; DROP TABLE devices;--")).toBeNull();
  });
});
