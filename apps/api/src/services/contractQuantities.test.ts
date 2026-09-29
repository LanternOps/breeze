import { describe, expect, it, vi } from 'vitest';
import { and } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({ db: {} }));
vi.mock('./groupMembership', () => ({ resolveEffectiveGroupMembers: vi.fn() }));

import { billableDeviceConds } from './contractQuantities';

describe('billableDeviceConds', () => {
  const compiled = () => {
    const query = new PgDialect().sqlToQuery(and(...billableDeviceConds('org-1'))!);
    return `${query.sql} ${JSON.stringify(query.params)}`;
  };

  it('never bills a device parked in a holding org', () => {
    expect(compiled()).toContain("parked_org.type = 'unassigned_pool'");
    expect(compiled()).toMatch(/NOT EXISTS \(SELECT 1 FROM organizations parked_org/);
  });

  it('keeps the decommissioned and ephemeral exclusions', () => {
    const text = compiled();
    expect(text).toContain('"devices"."status" <> $');
    expect(text).toContain('decommissioned');
    expect(text).toContain('"devices"."is_ephemeral" = $');
  });
});
