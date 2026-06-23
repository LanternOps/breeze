import { describe, it, expect } from 'vitest';
import { PERMISSION_GRANTS } from './permissions';

describe('PERMISSION_GRANTS topology grants', () => {
  it('exposes topology grants', () => {
    expect(PERMISSION_GRANTS.TOPOLOGY_WRITE).toEqual({ resource: 'topology', action: 'write' });
    expect(PERMISSION_GRANTS.TOPOLOGY_READ).toEqual({ resource: 'topology', action: 'read' });
  });
});
