import { describe, expect, it } from 'vitest';
import { toolInputSchemas } from './aiToolSchemas';

describe('sentinelone tool schemas', () => {
  it('accepts valid get_s1_status input', () => {
    const schema = toolInputSchemas['get_s1_status']!;
    const parsed = schema.safeParse({
      orgId: '00000000-0000-0000-0000-000000000001'
    });
    expect(parsed.success).toBe(true);
  });

  it('requires a device target for s1_isolate_device', () => {
    const schema = toolInputSchemas['s1_isolate_device']!;
    const parsed = schema.safeParse({ isolate: true });
    expect(parsed.success).toBe(false);
  });

  it('accepts valid s1_threat_action input', () => {
    const schema = toolInputSchemas['s1_threat_action']!;
    const parsed = schema.safeParse({
      action: 'quarantine',
      threatIds: ['threat-1']
    });
    expect(parsed.success).toBe(true);
  });
});
