import { describe, it, expect } from 'vitest';
import { buildInitializeResult } from './mcpServer';
import { API_VERSION } from '../version';

describe('buildInitializeResult (B-W01)', () => {
  it('negotiates: echoes a supported version, answers latest otherwise, defaults to latest', () => {
    expect(buildInitializeResult('2024-11-05').protocolVersion).toBe('2024-11-05');
    expect(buildInitializeResult('2025-06-18').protocolVersion).toBe('2025-06-18');
    expect(buildInitializeResult('2026-07-28').protocolVersion).toBe('2025-11-25');
    expect(buildInitializeResult().protocolVersion).toBe('2025-11-25');
  });

  it('reports the Breeze API version and a human title', () => {
    expect(buildInitializeResult().serverInfo).toEqual({ name: 'breeze-rmm', title: 'Breeze RMM', version: API_VERSION });
    expect(typeof API_VERSION).toBe('string');
    expect(API_VERSION.length).toBeGreaterThan(0);
  });

  it('returns a non-empty instructions string and advertises the prompts capability', () => {
    const r = buildInitializeResult();
    expect(r.instructions.length).toBeGreaterThan(200);
    expect(r.capabilities.prompts).toEqual({ listChanged: false });
  });
});
