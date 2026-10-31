import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { decryptCommandForDelivery, encryptSensitivePayloadFields, TERMINAL_PAYLOAD_STRIP_KEYS, TYPE_SCOPED_TERMINAL_STRIP_KEYS, terminalPayloadErasureSet } from './sensitiveCommandPayload';
process.env.APP_ENCRYPTION_KEY = 'isolation-test-key';
describe('network isolation payload privacy', () => {
  it('encrypts at enqueue and decrypts only the delivered copy', () => {
    const original = { actionType: 'network_isolation', breakGlassSecret: Buffer.alloc(32, 7).toString('base64'), parameters: { isolationId: 'episode', generation: 1 } };
    const persisted = encryptSensitivePayloadFields('execute_containment', original);
    expect(persisted.breakGlassSecret).not.toBe(original.breakGlassSecret);
    expect(persisted.breakGlassSecret).toMatch(/^enc:/);
    const delivered = decryptCommandForDelivery({ id: 'command', deviceId: 'device', type: 'execute_containment', payload: persisted });
    expect(delivered?.payload).toEqual(original);
    expect(persisted.breakGlassSecret).not.toBe(original.breakGlassSecret);
  });
  it('erases the secret only for execute_containment and preserves process_kill parameters', () => {
    expect(TYPE_SCOPED_TERMINAL_STRIP_KEYS.execute_containment).toEqual(['breakGlassSecret']);
    expect(TERMINAL_PAYLOAD_STRIP_KEYS).not.toContain('breakGlassSecret');
    expect(TERMINAL_PAYLOAD_STRIP_KEYS).not.toContain('parameters');
    const query = new PgDialect().sqlToQuery(terminalPayloadErasureSet().payload);
    expect(query.params.filter(x => x === 'breakGlassSecret')).toHaveLength(1);
    expect(query.params).toContain('execute_containment');
    const payload = { actionType: 'process_kill', parameters: { pid: 42, name: 'example-process' }, breakGlassSecret: 'unrelated-forensics' };
    expect(encryptSensitivePayloadFields('process_kill', payload)).toBe(payload);
  });
});
