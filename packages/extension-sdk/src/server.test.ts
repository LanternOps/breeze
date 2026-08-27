import { describe, expect, it } from 'vitest';
import { ExtensionAiError } from './server';

describe('ExtensionAiError', () => {
  it('carries the error code, message, and name for extensions to branch on', () => {
    const err = new ExtensionAiError('budget_exceeded', 'org budget exhausted');

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('budget_exceeded');
    expect(err.message).toBe('org budget exhausted');
    expect(err.name).toBe('ExtensionAiError');
  });
});
