import { describe, expect, it } from 'vitest';
import {
  PRESENCE_REASONS,
  PRESENCE_STATES,
  presenceResponseSchema,
} from './topologyPresence';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_D = '33333333-3333-4333-8333-333333333333';
const TS = '2026-10-12T10:00:00.000Z';

const sampleAssigned = () => ({
  deviceId: UUID_D,
  label: 'desktop-1',
  state: 'visiting' as const,
  reason: null,
  matchedSite: { id: UUID_B, name: 'Lakeside' },
  declaringSites: null,
  network: { prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1' },
  macCorroborated: false,
  observedAt: TS,
  freshUntil: TS,
  suggestion: null,
  siteAssignmentConfirmedAt: null,
});
const sampleVisitor = () => ({
  id: `presentation:overview:scope123:visitor-${'a'.repeat(40)}`,
  deviceId: UUID_D,
  label: 'laptop-1',
  assignedSite: { id: UUID_A, name: 'Main Office' },
  network: { prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1' },
  macCorroborated: true,
  observedAt: TS,
  freshUntil: TS,
  suggestion: null,
  siteAssignmentConfirmedAt: null,
});
const samplePresence = () => ({
  schemaVersion: 1 as const,
  siteId: UUID_B,
  asOf: TS,
  authority: false as const,
  coverage: 'complete' as const,
  ignoredDeclarations: 0,
  declaredNetworks: [
    { prefix: '10.1.5.0/24', sources: ['discovery_profile' as const], status: 'anchored' as const, gatewayAddresses: ['10.1.5.1'] },
  ],
  assigned: [sampleAssigned()],
  visitors: [sampleVisitor()],
  counts: { observedElsewhere: 1, unidentified: 0, unknown: 0, visiting: 1 },
  truncated: { assigned: false, visitors: false },
});

describe('presence vocab', () => {
  it('lists the states and reasons', () => {
    expect(PRESENCE_STATES).toEqual(['home', 'visiting', 'unrecognized', 'ambiguous', 'stale', 'unknown']);
    expect(PRESENCE_REASONS).toHaveLength(11);
  });
});

describe('presenceResponseSchema', () => {
  it('presence response: strict, authority false, bounded', () => {
    expect(presenceResponseSchema.safeParse(samplePresence()).success).toBe(true);
    expect(presenceResponseSchema.safeParse({ ...samplePresence(), authority: true }).success).toBe(false);
    expect(presenceResponseSchema.safeParse({ ...samplePresence(), visitors: Array(501).fill(sampleVisitor()) }).success).toBe(false);
    expect(presenceResponseSchema.safeParse({ ...samplePresence(), visitors: [{ ...sampleVisitor(), canonicalNodeId: 'x' }] }).success).toBe(false);
  });
  it('bounds assigned at 1000', () => {
    expect(presenceResponseSchema.safeParse({ ...samplePresence(), assigned: Array(1001).fill(sampleAssigned()) }).success).toBe(false);
    expect(presenceResponseSchema.safeParse({ ...samplePresence(), assigned: Array(1000).fill(sampleAssigned()) }).success).toBe(true);
  });
  it('rejects unknown state and reason', () => {
    expect(presenceResponseSchema.safeParse({ ...samplePresence(), assigned: [{ ...sampleAssigned(), state: 'away' }] }).success).toBe(false);
    expect(presenceResponseSchema.safeParse({ ...samplePresence(), assigned: [{ ...sampleAssigned(), reason: 'because' }] }).success).toBe(false);
    expect(presenceResponseSchema.safeParse({ ...samplePresence(), assigned: [{ ...sampleAssigned(), reason: 'not_declared' }] }).success).toBe(true);
  });
  it('rejects extra top-level and nested keys', () => {
    expect(presenceResponseSchema.safeParse({ ...samplePresence(), extra: 1 }).success).toBe(false);
    expect(presenceResponseSchema.safeParse({ ...samplePresence(), counts: { observedElsewhere: 0, unidentified: 0, unknown: 0, visiting: 0, x: 1 } }).success).toBe(false);
    expect(presenceResponseSchema.safeParse({ ...samplePresence(), truncated: { assigned: false } }).success).toBe(false);
  });
  it('rejects a malformed visitor id and negative counts', () => {
    expect(presenceResponseSchema.safeParse({ ...samplePresence(), visitors: [{ ...sampleVisitor(), id: 'visitor-1' }] }).success).toBe(false);
    expect(presenceResponseSchema.safeParse({ ...samplePresence(), counts: { observedElsewhere: -1, unidentified: 0, unknown: 0, visiting: 0 } }).success).toBe(false);
  });
});
