import { describe, expect, it } from 'vitest';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';

const TEST_DEVICE_ID = '00000000-0000-0000-0000-000000000001';

describe('get_ip_history schema', () => {
  const schema = toolInputSchemas['get_ip_history']!;

  it('accepts timeline mode input', () => {
    const result = schema.safeParse({
      device_id: TEST_DEVICE_ID,
      limit: 50,
      active_only: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts reverse lookup input', () => {
    const result = schema.safeParse({
      ip_address: '10.0.1.50',
      at_time: '2026-02-10T14:30:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects input with neither device_id nor ip_address', () => {
    const result = schema.safeParse({
      limit: 10,
    });
    expect(result.success).toBe(false);
  });

  it('rejects reverse lookup without at_time', () => {
    const result = schema.safeParse({
      ip_address: '10.0.1.50',
    });
    expect(result.success).toBe(false);
  });
});

describe('validateToolInput(get_ip_history)', () => {
  it('returns success for valid timeline input', () => {
    const result = validateToolInput('get_ip_history', {
      device_id: TEST_DEVICE_ID,
      since: '2026-02-01T00:00:00Z',
      until: '2026-02-28T23:59:59Z',
    });
    expect(result.success).toBe(true);
  });

  it('returns an error for invalid reverse lookup input', () => {
    const result = validateToolInput('get_ip_history', {
      ip_address: '10.0.1.50',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('at_time');
    }
  });
});
