import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolSurfaceFingerprint } from './aiToolSurfaceFingerprint';

const a = { name: 'manage_services', description: 'Start, stop or restart a service', inputSchema: { action: z.enum(['start', 'stop']), deviceId: z.string() } };
const b = { name: 'query_devices', description: 'Find devices', inputSchema: { status: z.string().optional() } };

describe('toolSurfaceFingerprint (#12421 Decision 3)', () => {
  const base = { tools: [a, b], examplesApplied: false, searchEnabled: true };

  it('is 16 hex chars, deterministic, and independent of tool order', () => {
    const fp = toolSurfaceFingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(toolSurfaceFingerprint(base)).toBe(fp);
    expect(toolSurfaceFingerprint({ ...base, tools: [b, a] })).toBe(fp);
  });

  it('moves with a description, a schema, the tool set, examples and search', () => {
    const fp = toolSurfaceFingerprint(base);
    const variants = [
      { ...base, tools: [{ ...a, description: `${a.description}.` }, b] },
      { ...base, tools: [{ ...a, inputSchema: { ...a.inputSchema, extra: z.number() } }, b] },
      { ...base, tools: [a] },
      { ...base, examplesApplied: true },
      { ...base, searchEnabled: false },
    ];
    const prints = variants.map(toolSurfaceFingerprint);
    for (const p of prints) expect(p).not.toBe(fp);
    expect(new Set(prints).size).toBe(prints.length);
  });

  it('accepts a whole Zod schema as well as a raw shape, and survives an unrepresentable one', () => {
    const whole = { ...a, inputSchema: z.object(a.inputSchema) };
    expect(toolSurfaceFingerprint({ ...base, tools: [whole, b] })).toBe(toolSurfaceFingerprint(base));
    const odd = { name: 'odd', description: 'x', inputSchema: { when: z.date() } };
    expect(toolSurfaceFingerprint({ ...base, tools: [odd] })).toMatch(/^[0-9a-f]{16}$/);
  });
});
