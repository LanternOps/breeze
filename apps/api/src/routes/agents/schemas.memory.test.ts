import { describe, expect, it } from 'vitest';
import { agentMemoryInventorySchema, updateHardwareSchema } from './schemas';

// #5351 wire contract: docs/superpowers/specs/device-lifecycle/2026-09-26-memory-modules-design.md
const module = (overrides: Record<string, unknown> = {}) => ({
  slotKey: 'smbios:0x1100',
  locator: 'DIMM_A1',
  bankLabel: 'BANK 0',
  populated: true,
  capacityMb: 16384,
  memoryType: 'DDR4',
  formFactor: 'DIMM',
  speedMts: 3200,
  configuredSpeedMts: 2933,
  manufacturer: 'Samsung',
  partNumber: 'M378A2K43DB1-CTD',
  serialNumber: '12345678',
  ...overrides,
});

const memory = (overrides: Record<string, unknown> = {}) => ({
  slotsTotal: 4,
  maxCapacityMb: 131072,
  soldered: false,
  modules: [module(), module({ slotKey: 'smbios:0x1101', locator: 'DIMM_A2', populated: false, capacityMb: null })],
  ...overrides,
});

describe('agentMemoryInventorySchema (#5351)', () => {
  it('accepts the documented wire shape', () => {
    const parsed = agentMemoryInventorySchema.safeParse(memory());
    expect(parsed.success).toBe(true);
  });

  it('accepts a minimal module (only required fields) and a memory block with only modules', () => {
    const parsed = agentMemoryInventorySchema.safeParse({
      modules: [{ slotKey: 'macos:BANK 0/DIMM0', locator: 'DIMM0', populated: false }],
    });
    expect(parsed.success).toBe(true);
  });

  // The agent OMITS unknown optional fields (it does not send null), and
  // omits slotsTotal/maxCapacityMb when unknown — a missing key must never
  // reject the block. Apple Silicon: soldered + one on-package entry.
  it('accepts a module carrying only slotKey/locator/populated (every optional key omitted)', () => {
    const parsed = agentMemoryInventorySchema.safeParse({
      modules: [{ slotKey: 'smbios:0x1100', locator: 'DIMM_A1', populated: true }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.modules[0]).toEqual({ slotKey: 'smbios:0x1100', locator: 'DIMM_A1', populated: true });
  });

  it('accepts the Apple Silicon shape: soldered, one on-package module, no slotsTotal/maxCapacityMb', () => {
    const parsed = agentMemoryInventorySchema.safeParse({
      soldered: true,
      modules: [{ slotKey: 'macos:on-package', locator: 'On-package', populated: true, capacityMb: 16384, memoryType: 'LPDDR5' }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).not.toHaveProperty('slotsTotal');
  });

  it('accepts nulls for every optional field', () => {
    const parsed = agentMemoryInventorySchema.safeParse({
      slotsTotal: null, maxCapacityMb: null, soldered: null,
      modules: [module({
        bankLabel: null, capacityMb: null, memoryType: null, formFactor: null, speedMts: null,
        configuredSpeedMts: null, manufacturer: null, partNumber: null, serialNumber: null,
      })],
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['modules missing', { slotsTotal: 2 }],
    ['modules not an array', memory({ modules: 'nope' })],
    ['more than 256 modules', memory({ modules: Array.from({ length: 257 }, (_, i) => module({ slotKey: `k${i}` })) })],
    ['slotsTotal above 256', memory({ slotsTotal: 257 })],
    ['negative slotsTotal', memory({ slotsTotal: -1 })],
    ['fractional capacity', memory({ modules: [module({ capacityMb: 1.5 })] })],
    ['negative speed', memory({ modules: [module({ speedMts: -1 })] })],
    ['empty slotKey', memory({ modules: [module({ slotKey: '' })] })],
    ['slotKey over 160', memory({ modules: [module({ slotKey: 'k'.repeat(161) })] })],
    ['empty locator', memory({ modules: [module({ locator: '' })] })],
    ['locator over 128', memory({ modules: [module({ locator: 'l'.repeat(129) })] })],
    ['memoryType over 32', memory({ modules: [module({ memoryType: 'x'.repeat(33) })] })],
    ['serialNumber over 128', memory({ modules: [module({ serialNumber: 's'.repeat(129) })] })],
    ['populated missing', memory({ modules: [{ slotKey: 'k', locator: 'l' }] })],
    ['duplicate slotKey', memory({ modules: [module(), module({ locator: 'DIMM_B1' })] })],
    ['soldered not boolean', memory({ soldered: 'yes' })],
    ['capacity beyond int4', memory({ modules: [module({ capacityMb: 2 ** 31 })] })],
  ])('rejects %s', (_label, value) => {
    expect(agentMemoryInventorySchema.safeParse(value).success).toBe(false);
  });

  it('accepts exactly 256 modules and slotsTotal 256', () => {
    const parsed = agentMemoryInventorySchema.safeParse(memory({
      slotsTotal: 256,
      modules: Array.from({ length: 256 }, (_, i) => module({ slotKey: `k${i}` })),
    }));
    expect(parsed.success).toBe(true);
  });
});

describe('updateHardwareSchema memory passthrough (#5351)', () => {
  it('keeps the raw memory key so the route can validate it separately', () => {
    const parsed = updateHardwareSchema.safeParse({ cpuModel: 'x', memory: { modules: 'invalid' } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.memory).toEqual({ modules: 'invalid' });
  });

  it('does not fail the base hardware body when memory is malformed', () => {
    expect(updateHardwareSchema.safeParse({ cpuModel: 'x', memory: 42 }).success).toBe(true);
  });
});
