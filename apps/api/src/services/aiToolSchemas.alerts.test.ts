import { describe, expect, it } from 'vitest';
import { toolInputSchemas } from './aiToolSchemas';

const ALERT_ID = '00000000-0000-0000-0000-000000000001';

describe('manage_alerts tool schema (review round 1, IMPORTANT 5, P2-1)', () => {
  const schema = toolInputSchemas['manage_alerts']!;

  it('accepts a suppress action with a suppressDuration', () => {
    const parsed = schema.safeParse({ action: 'suppress', alertId: ALERT_ID, suppressDuration: 24 });
    expect(parsed.success).toBe(true);
  });

  it('accepts suppressDuration: 0 (suppress forever)', () => {
    const parsed = schema.safeParse({ action: 'suppress', alertId: ALERT_ID, suppressDuration: 0 });
    expect(parsed.success).toBe(true);
  });

  it('accepts a suppress action with no suppressDuration (tool default applies)', () => {
    const parsed = schema.safeParse({ action: 'suppress', alertId: ALERT_ID });
    expect(parsed.success).toBe(true);
  });

  it('rejects suppressDuration above the 720-hour ceiling', () => {
    const parsed = schema.safeParse({ action: 'suppress', alertId: ALERT_ID, suppressDuration: 721 });
    expect(parsed.success).toBe(false);
  });

  it('rejects a negative suppressDuration', () => {
    const parsed = schema.safeParse({ action: 'suppress', alertId: ALERT_ID, suppressDuration: -1 });
    expect(parsed.success).toBe(false);
  });

  it('requires alertId for a suppress action', () => {
    const parsed = schema.safeParse({ action: 'suppress', suppressDuration: 24 });
    expect(parsed.success).toBe(false);
  });

  it('still accepts a resolve action (no suppressDuration involved)', () => {
    const parsed = schema.safeParse({ action: 'resolve', alertId: ALERT_ID, resolutionNote: 'Fixed.' });
    expect(parsed.success).toBe(true);
  });

  it('still accepts a list action with no alertId', () => {
    const parsed = schema.safeParse({ action: 'list', status: 'active' });
    expect(parsed.success).toBe(true);
  });
});
