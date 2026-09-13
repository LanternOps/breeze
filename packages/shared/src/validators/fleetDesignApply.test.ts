import { describe, expect, it } from 'vitest';
import { fleetDesignApprovalSchema } from './fleetDesignApply';

describe('fleetDesignApprovalSchema', () => {
  it('accepts an empty approval and defaults every array', () => {
    const parsed = fleetDesignApprovalSchema.parse({});
    expect(parsed).toEqual({
      functions: [], monitoring: [], retired: [], automation: [], legacy: [], roleCorrections: [], displacementsAccepted: [],
    });
  });

  it('accepts well-formed refs', () => {
    const parsed = fleetDesignApprovalSchema.parse({
      functions: ['file_server', 'custom:kiosk-1'],
      monitoring: ['monitoring:file_server:watch:0', 'monitoring:custom:kiosk-1:rule:12'],
      retired: ['retired:3'],
      automation: ['automation:file_server:script:0'],
      legacy: ['legacy:11111111-1111-4111-8111-111111111111'],
      roleCorrections: ['22222222-2222-4222-8222-222222222222'],
      displacementsAccepted: ['33333333-3333-4333-8333-333333333333'],
    });
    expect(parsed.monitoring).toHaveLength(2);
  });

  it('rejects unknown keys', () => {
    expect(fleetDesignApprovalSchema.safeParse({ extra: [] }).success).toBe(false);
  });

  it('rejects malformed refs', () => {
    expect(fleetDesignApprovalSchema.safeParse({ monitoring: ['monitoring:file_server:watch'] }).success).toBe(false);
    expect(fleetDesignApprovalSchema.safeParse({ retired: ['retired:x'] }).success).toBe(false);
    expect(fleetDesignApprovalSchema.safeParse({ functions: ['Not A Key'] }).success).toBe(false);
    expect(fleetDesignApprovalSchema.safeParse({ roleCorrections: ['not-a-uuid'] }).success).toBe(false);
    expect(fleetDesignApprovalSchema.safeParse({ legacy: ['legacy:nope'] }).success).toBe(false);
  });

  it('bounds every array at 2000', () => {
    expect(fleetDesignApprovalSchema.safeParse({ retired: Array.from({ length: 2001 }, (_, i) => `retired:${i}`) }).success).toBe(false);
  });
});
