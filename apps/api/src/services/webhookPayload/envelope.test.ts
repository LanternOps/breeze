import { describe, expect, it } from 'vitest';
import { buildWebhookEnvelope } from './envelope';
const input = { id: 'event-1', type: 'device.offline', orgId: 'org-1', timestamp: '2026-10-28T12:00:00.000Z', data: { deviceId: 'device-1' }, replayOf: null };
describe('webhook envelope', () => {
  it('keeps the v2 field order and explicit null replay root', () => {
    expect(buildWebhookEnvelope({ ...input, version: 2 })).toBe('{"id":"event-1","type":"device.offline","timestamp":"2026-10-28T12:00:00.000Z","orgId":"org-1","schemaVersion":2,"replayOf":null,"data":{"deviceId":"device-1"}}');
  });
  it('includes the original replay root in v2', () => {
    expect(JSON.parse(buildWebhookEnvelope({ ...input, version: 2, replayOf: 'root' })).replayOf).toBe('root');
  });
  it('ignores replay root and drops a missing timestamp in v1', () => {
    expect(buildWebhookEnvelope({ ...input, version: 1, timestamp: undefined as never, replayOf: 'root' })).toBe('{"id":"event-1","type":"device.offline","orgId":"org-1","data":{"deviceId":"device-1"}}');
  });
});
