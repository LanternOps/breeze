import { describe, expect, it } from 'vitest';
import { MIGRATION_WINDOW_MAX_ORGS, migrationWindowOpenStepUpResourceSchema } from './migrationWindows';

const ID = '6f1c2b0a-5d4e-4f3a-8b2c-1d0e9f8a7b6c';
const base = { partnerId: ID, principalId: ID, orgIds: [ID], endsAt: '2026-11-15T08:00:00.000Z', writesPerHour: 6000 };

describe('migrationWindowOpenStepUpResourceSchema (#8313)', () => {
  it('accepts the window the wizard opens, writesPerHour optional', () => {
    expect(migrationWindowOpenStepUpResourceSchema.parse(base)).toEqual(base);
    const { writesPerHour: _omitted, ...rest } = base;
    expect(migrationWindowOpenStepUpResourceSchema.safeParse(rest).success).toBe(true);
  });

  it('refuses no orgs, too many orgs, a non-ISO end and a fractional rate', () => {
    expect(migrationWindowOpenStepUpResourceSchema.safeParse({ ...base, orgIds: [] }).success).toBe(false);
    expect(migrationWindowOpenStepUpResourceSchema.safeParse({ ...base, orgIds: Array(MIGRATION_WINDOW_MAX_ORGS + 1).fill(ID) }).success).toBe(false);
    expect(migrationWindowOpenStepUpResourceSchema.safeParse({ ...base, endsAt: '2026-11-15 08:00' }).success).toBe(false);
    expect(migrationWindowOpenStepUpResourceSchema.safeParse({ ...base, writesPerHour: 1.5 }).success).toBe(false);
  });
});
