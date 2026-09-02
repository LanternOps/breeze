import { describe, expect, it } from 'vitest';
import { promoteSupervisedKeyRequestSchema } from './aiAgentGraduation';

const VALID_UUID = '9c7f6b8a-1234-4abc-9def-0123456789ab';

describe('promoteSupervisedKeyRequestSchema', () => {
  it('accepts a well-formed request', () => {
    const result = promoteSupervisedKeyRequestSchema.safeParse({
      orgId: VALID_UUID,
      kind: 'triage',
      opKey: 'manage_services:restart',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a dot-separated opKey (act-op keys are never promotable)', () => {
    const result = promoteSupervisedKeyRequestSchema.safeParse({
      orgId: VALID_UUID,
      kind: 'triage',
      opKey: 'manage_services.restart',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown extra field (strict)', () => {
    const result = promoteSupervisedKeyRequestSchema.safeParse({
      orgId: VALID_UUID,
      kind: 'triage',
      opKey: 'manage_services:restart',
      extra: 'nope',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid orgId', () => {
    const result = promoteSupervisedKeyRequestSchema.safeParse({
      orgId: 'not-a-uuid',
      kind: 'triage',
      opKey: 'manage_services:restart',
    });
    expect(result.success).toBe(false);
  });
});
