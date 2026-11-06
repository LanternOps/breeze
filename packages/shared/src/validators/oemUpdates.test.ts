import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  oemUpdateReleasePayloadSchema,
  oemUpdateReleaseResultSchema,
  oemUpdateRunPayloadSchema,
  oemUpdateRunResultSchema,
  oemUpdateVerificationSchema,
} from './oemUpdates';

const sample = JSON.parse(
  readFileSync(new URL('./__fixtures__/oemUpdateResult.sample.json', import.meta.url), 'utf8'),
);

const sha = 'a'.repeat(64);
const uuid = '123e4567-e89b-42d3-a456-426614174000';
const payload = (over: Record<string, unknown> = {}): any => ({
  lane: 'dell',
  trigger: 'scheduled',
  occurrenceKey: '2026-11-05T02:00:00Z',
  categories: ['bios', 'driver'],
  blockedUpdateIds: [],
  rebootControlled: true,
  notAfter: '2026-11-05T06:00:00+00:00',
  escrowedProtectorIds: [uuid],
  tool: {
    version: '5.4.0',
    minSafeVersion: '5.0.0',
    supportedRange: { min: '5.0.0', maxExclusive: '6.0.0' },
    url: 'https://example.com/tool.exe',
    sha256: sha,
    prerequisites: [{ name: 'dotnet-desktop', minVersion: '8.0.0', url: 'https://example.com/p.exe', sha256: sha }],
  },
  ...over,
});

const okPayload = (over: Record<string, unknown> = {}) => oemUpdateRunPayloadSchema.safeParse(payload(over)).success;
const okResult = (v: unknown) => oemUpdateRunResultSchema.safeParse(v).success;

describe('oemUpdateRunPayloadSchema', () => {
  it('accepts a valid payload', () => {
    expect(okPayload()).toBe(true);
  });
  it('accepts tool: null', () => {
    expect(okPayload({ tool: null, occurrenceKey: null })).toBe(true);
  });
  it('rejects an unknown key (top-level and nested)', () => {
    const p = payload();
    expect(okPayload({ extra: 1 })).toBe(false);
    expect(okPayload({ tool: { ...p.tool, extra: 1 } })).toBe(false);
    expect(okPayload({ tool: { ...p.tool, supportedRange: { ...p.tool.supportedRange, extra: 1 } } })).toBe(false);
    expect(okPayload({ tool: { ...p.tool, prerequisites: [{ ...p.tool.prerequisites[0], extra: 1 }] } })).toBe(false);
  });
  it('rejects 201 blockedUpdateIds and a 129-char id', () => {
    expect(okPayload({ blockedUpdateIds: Array(201).fill('x') })).toBe(false);
    expect(okPayload({ blockedUpdateIds: Array(200).fill('x') })).toBe(true);
    expect(okPayload({ blockedUpdateIds: ['x'.repeat(129)] })).toBe(false);
    expect(okPayload({ blockedUpdateIds: ['x'.repeat(128)] })).toBe(true);
  });
  it('rejects 17 protector ids', () => {
    expect(okPayload({ escrowedProtectorIds: Array(17).fill(uuid) })).toBe(false);
    expect(okPayload({ escrowedProtectorIds: Array(16).fill(uuid) })).toBe(true);
    expect(okPayload({ escrowedProtectorIds: ['nope'] })).toBe(false);
  });
  it('rejects duplicate categories', () => {
    expect(okPayload({ categories: ['bios', 'bios'] })).toBe(false);
  });
  it('rejects a non-https tool url', () => {
    const p = payload();
    expect(okPayload({ tool: { ...p.tool, url: 'http://example.com/t.exe' } })).toBe(false);
    expect(okPayload({ tool: { ...p.tool, url: 'ftp://example.com/t.exe' } })).toBe(false);
  });
  it('rejects a non-hex or wrong-length sha256', () => {
    const p = payload();
    expect(okPayload({ tool: { ...p.tool, sha256: 'z'.repeat(64) } })).toBe(false);
    expect(okPayload({ tool: { ...p.tool, sha256: 'a'.repeat(63) } })).toBe(false);
  });
  it('rejects a bad notAfter', () => {
    expect(okPayload({ notAfter: 'tomorrow' })).toBe(false);
  });
});

describe('oemUpdateRunResultSchema', () => {
  it('parses the sample fixture', () => {
    expect(okResult(sample)).toBe(true);
  });
  it('rejects an unknown key (top-level and nested)', () => {
    expect(okResult({ ...sample, extra: 1 })).toBe(false);
    expect(okResult({ ...sample, items: [{ ...sample.items[0], extra: 1 }] })).toBe(false);
    expect(okResult({ ...sample, skippedCategories: [{ category: 'bios', reason: 'power', extra: 1 }] })).toBe(false);
  });
  it('rejects 201 items', () => {
    expect(okResult({ ...sample, items: Array(201).fill(sample.items[0]) })).toBe(false);
    expect(okResult({ ...sample, items: Array(200).fill(sample.items[0]) })).toBe(true);
  });
  it('rejects a title over 200', () => {
    expect(okResult({ ...sample, items: [{ ...sample.items[0], title: 'x'.repeat(201) }] })).toBe(false);
    expect(okResult({ ...sample, items: [{ ...sample.items[0], title: 'x'.repeat(200) }] })).toBe(true);
  });
  it('rejects an outcome outside the 12', () => {
    expect(okResult({ ...sample, outcome: 'exploded' })).toBe(false);
  });
  it('rejects a non-integer exit code', () => {
    expect(okResult({ ...sample, rawExitCode: 1.5 })).toBe(false);
  });
});

// Review round 1: vendor tool output is untrusted, and the manifest is ours.
describe('oem update contract bounds', () => {
  it('requires a lowercase sha256, as the agent compares it', () => {
    expect(okPayload({ tool: { ...payload().tool, sha256: 'A'.repeat(64) } })).toBe(false);
  });
  it('requires at least one category', () => {
    expect(okPayload({ categories: [] })).toBe(false);
  });
  it('bounds the exit code to what a Windows process can return', () => {
    expect(okResult({ ...sample, rawExitCode: 4294967295 })).toBe(true);
    expect(okResult({ ...sample, rawExitCode: -2147483648 })).toBe(true);
    expect(okResult({ ...sample, rawExitCode: 4294967296 })).toBe(false);
    expect(okResult({ ...sample, rawExitCode: -2147483649 })).toBe(false);
  });
  it('limits errorCode to an identifier', () => {
    expect(okResult({ ...sample, errorCode: 'dcu.exit_500' })).toBe(true);
    expect(okResult({ ...sample, errorCode: 'bad code' })).toBe(false);
    expect(okResult({ ...sample, errorCode: '' })).toBe(false);
  });
  it('rejects control characters in text from the tool', () => {
    const item = sample.items[0];
    expect(okResult({ ...sample, items: [{ ...item, title: 'BIOS\u0007' }] })).toBe(false);
    expect(okResult({ ...sample, items: [{ ...item, version: '1.0\n2' }] })).toBe(false);
    expect(okResult({ ...sample, toolVersion: '5.7.2\u0000' })).toBe(false);
  });
});

describe('oemUpdateVerificationSchema', () => {
  const v = { commandId: uuid, bitlockerAfter: 'on', biosVersionAfter: null };
  const ok = (x: unknown) => oemUpdateVerificationSchema.safeParse(x).success;
  it('accepts valid and rejects unknown keys / bad values', () => {
    expect(ok(v)).toBe(true);
    expect(ok({ ...v, extra: 1 })).toBe(false);
    expect(ok({ ...v, bitlockerAfter: 'maybe' })).toBe(false);
    expect(ok({ ...v, commandId: 'x' })).toBe(false);
  });
});

describe('oem update release contracts', () => {
  it('payload is a strict lane', () => {
    expect(oemUpdateReleasePayloadSchema.safeParse({ lane: 'dell' }).success).toBe(true);
    expect(oemUpdateReleasePayloadSchema.safeParse({ lane: 'acme' }).success).toBe(false);
    expect(oemUpdateReleasePayloadSchema.safeParse({}).success).toBe(false);
    expect(oemUpdateReleasePayloadSchema.safeParse({ lane: 'dell', extra: 1 }).success).toBe(false);
  });
  it('result carries a known outcome and an identifier errorCode', () => {
    const ok = (v: unknown) => oemUpdateReleaseResultSchema.safeParse(v).success;
    expect(ok({ lane: 'hp', outcome: 'restored' })).toBe(true);
    expect(ok({ lane: 'hp', outcome: 'failed', errorCode: 'export.timeout' })).toBe(true);
    expect(ok({ lane: 'hp', outcome: 'nothing_to_restore', errorCode: null })).toBe(true);
    expect(ok({ lane: 'hp', outcome: 'done' })).toBe(false);
    expect(ok({ lane: 'hp', outcome: 'failed', errorCode: 'bad code' })).toBe(false);
    expect(ok({ lane: 'hp', outcome: 'failed', errorCode: 'x'.repeat(65) })).toBe(false);
    expect(ok({ lane: 'hp', outcome: 'restored', extra: 1 })).toBe(false);
  });
});
