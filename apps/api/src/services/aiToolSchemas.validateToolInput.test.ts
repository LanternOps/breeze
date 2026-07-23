import { describe, expect, it } from 'vitest';
import { validateToolInput } from './aiToolSchemas';

const TEST_UUID = '00000000-0000-0000-0000-000000000001';

describe('validateToolInput error formatting', () => {
  it('rejects an unregistered tool', () => {
    const result = validateToolInput('not_a_real_tool', {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('No input schema registered');
    }
  });

  it('accepts valid input', () => {
    expect(validateToolInput('manage_patches', { action: 'list' })).toEqual({ success: true });
  });

  // Regression for #2604: object-level refinements carry an empty `path`, so the
  // old `${path}: ${message}` formatting produced a doubled colon
  // ("Invalid input: : patchIds and deviceIds are required for install").
  it('does not emit a doubled colon for object-level refinement failures', () => {
    const result = validateToolInput('manage_patches', { action: 'install' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Invalid input: patchIds and deviceIds are required for install');
      expect(result.error).not.toContain(': :');
    }
  });

  it('still prefixes the field path for field-level failures', () => {
    // `action` must be one of the enum values — this is a field-level issue with
    // a non-empty path, so the path prefix must be preserved.
    const result = validateToolInput('manage_patches', { action: 'not_an_action' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('action:');
      expect(result.error).not.toContain(': :');
    }
  });

  it('joins multiple issues without a leading colon on the refinement message', () => {
    // Bad enum (field-level, has path) alongside a satisfied action keeps the
    // banner clean; the key invariant is no ` : ` artifact anywhere.
    const result = validateToolInput('manage_patches', { action: 'scan' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Invalid input: deviceIds is required for scan');
    }
  });
});
