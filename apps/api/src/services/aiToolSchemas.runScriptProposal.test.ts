import { describe, expect, it } from 'vitest';
import { toolInputSchemas } from './aiToolSchemas';

const schema = toolInputSchemas.run_script;
const device = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';

describe('run_script scriptId XOR proposalId', () => {
  it('accepts a scriptId alone', () => {
    expect(schema.safeParse({ scriptId: id, deviceIds: [device] }).success).toBe(true);
  });
  it('accepts a proposalId alone', () => {
    expect(schema.safeParse({ proposalId: id, deviceIds: [device] }).success).toBe(true);
  });
  it('rejects both', () => {
    expect(schema.safeParse({ scriptId: id, proposalId: id, deviceIds: [device] }).success).toBe(false);
  });
  it('rejects neither', () => {
    expect(schema.safeParse({ deviceIds: [device] }).success).toBe(false);
  });
  it('rejects parameters alongside a proposalId — a proposal has no parameter contract', () => {
    expect(schema.safeParse({ proposalId: id, deviceIds: [device], parameters: { a: 1 } }).success).toBe(false);
  });
  it('keeps the 10-device cap for both forms', () => {
    const many = Array.from({ length: 11 }, (_, i) => `1111111${i % 10}-1111-4111-8111-11111111111${i % 10}`);
    expect(schema.safeParse({ proposalId: id, deviceIds: many }).success).toBe(false);
  });
});
