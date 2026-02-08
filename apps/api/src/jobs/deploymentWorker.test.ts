import { describe, expect, it } from 'vitest';

import { isSuccessfulAgentCommand } from './deploymentWorker';

describe('isSuccessfulAgentCommand', () => {
  it('treats completed command with exitCode 0 as success', () => {
    expect(isSuccessfulAgentCommand('completed', { exitCode: 0 })).toBe(true);
  });

  it('treats completed command with non-zero exitCode as failure', () => {
    expect(isSuccessfulAgentCommand('completed', { exitCode: 1 })).toBe(false);
  });

  it('falls back to legacy success field when exitCode is missing', () => {
    expect(isSuccessfulAgentCommand('completed', { success: true })).toBe(true);
    expect(isSuccessfulAgentCommand('completed', { success: false })).toBe(false);
  });

  it('treats non-completed statuses as failure', () => {
    expect(isSuccessfulAgentCommand('failed', { exitCode: 0 })).toBe(false);
  });
});
