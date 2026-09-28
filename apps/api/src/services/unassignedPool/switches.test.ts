import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rows: Array<{ enabled: boolean }> = [];
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) })),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { db } from '../../db';
import { isDeployKeyEnrollmentEnabled, preAssignmentPlatformEnabled } from './switches';

describe('pre-assignment enrollment switches', () => {
  const original = process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED;
  beforeEach(() => {
    rows.length = 0;
    vi.mocked(db.select).mockClear();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED;
    else process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED = original;
  });

  it('the platform flag defaults off', () => {
    delete process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED;
    expect(preAssignmentPlatformEnabled()).toBe(false);
    process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED = 'garbage';
    expect(preAssignmentPlatformEnabled()).toBe(false);
    process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED = 'true';
    expect(preAssignmentPlatformEnabled()).toBe(true);
  });

  it('is off when the platform flag is off, without reading the partner', async () => {
    delete process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED;
    rows.push({ enabled: true });
    expect(await isDeployKeyEnrollmentEnabled('partner-1')).toBe(false);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('is off when the partner column is off', async () => {
    process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED = 'true';
    rows.push({ enabled: false });
    expect(await isDeployKeyEnrollmentEnabled('partner-1')).toBe(false);
  });

  it('is off for an unknown partner', async () => {
    process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED = 'true';
    expect(await isDeployKeyEnrollmentEnabled('partner-1')).toBe(false);
  });

  it('is on only when both the platform flag and the partner column are on', async () => {
    process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED = 'true';
    rows.push({ enabled: true });
    expect(await isDeployKeyEnrollmentEnabled('partner-1')).toBe(true);
  });
});
