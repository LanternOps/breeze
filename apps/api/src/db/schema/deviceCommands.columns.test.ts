import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { deviceCommands } from './devices';

describe('deviceCommands deferred-delivery columns (#5128 W1)', () => {
  it('declares deliver_by as a nullable timestamptz', () => {
    const cols = getTableColumns(deviceCommands);
    expect(cols.deliverBy).toBeDefined();
    expect(cols.deliverBy.name).toBe('deliver_by');
    expect(cols.deliverBy.notNull).toBe(false);
  });

  it('declares submitted_org_id as a nullable uuid (provenance, not tenancy)', () => {
    const cols = getTableColumns(deviceCommands);
    expect(cols.submittedOrgId).toBeDefined();
    expect(cols.submittedOrgId.name).toBe('submitted_org_id');
    expect(cols.submittedOrgId.notNull).toBe(false);
  });

  it('does NOT declare an org_id column — the table stays system-scoped', () => {
    const cols = getTableColumns(deviceCommands);
    expect(Object.values(cols).map((c) => c.name)).not.toContain('org_id');
  });
});
