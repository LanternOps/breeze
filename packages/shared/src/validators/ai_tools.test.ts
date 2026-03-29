import { describe, it, expect } from 'vitest';
import {
  scriptBuilderContextSchema,
  createScriptBuilderSessionSchema,
} from './ai';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

// ============================================
// Script Builder Schemas
// ============================================

describe('scriptBuilderContextSchema', () => {
  it('should accept empty context (all optional)', () => {
    const result = scriptBuilderContextSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept context with scriptId', () => {
    const result = scriptBuilderContextSchema.safeParse({
      scriptId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid scriptId', () => {
    const result = scriptBuilderContextSchema.safeParse({
      scriptId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('should accept full editor snapshot', () => {
    const result = scriptBuilderContextSchema.safeParse({
      scriptId: VALID_UUID,
      editorSnapshot: {
        name: 'Install Updates',
        content: 'Get-WindowsUpdate -Install',
        description: 'Installs pending Windows updates',
        language: 'powershell',
        osTypes: ['windows'],
        category: 'maintenance',
        parameters: [
          {
            name: 'reboot',
            type: 'boolean',
            defaultValue: 'false',
            required: true,
          },
        ],
        runAs: 'system',
        timeoutSeconds: 600,
      },
    });
    expect(result.success).toBe(true);
  });

  it('should accept all valid script languages', () => {
    const languages = ['powershell', 'bash', 'python', 'cmd'] as const;
    for (const language of languages) {
      const result = scriptBuilderContextSchema.safeParse({
        editorSnapshot: { language },
      });
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid script language', () => {
    const result = scriptBuilderContextSchema.safeParse({
      editorSnapshot: { language: 'ruby' },
    });
    expect(result.success).toBe(false);
  });

  it('should accept all valid osTypes', () => {
    const result = scriptBuilderContextSchema.safeParse({
      editorSnapshot: { osTypes: ['windows', 'macos', 'linux'] },
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid osType', () => {
    const result = scriptBuilderContextSchema.safeParse({
      editorSnapshot: { osTypes: ['freebsd'] },
    });
    expect(result.success).toBe(false);
  });

  it('should accept all valid runAs values', () => {
    const values = ['system', 'user', 'elevated'] as const;
    for (const runAs of values) {
      const result = scriptBuilderContextSchema.safeParse({
        editorSnapshot: { runAs },
      });
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid runAs value', () => {
    const result = scriptBuilderContextSchema.safeParse({
      editorSnapshot: { runAs: 'admin' },
    });
    expect(result.success).toBe(false);
  });

  it('should accept all parameter types', () => {
    const types = ['string', 'number', 'boolean', 'select'] as const;
    for (const type of types) {
      const result = scriptBuilderContextSchema.safeParse({
        editorSnapshot: {
          parameters: [{ name: 'param', type }],
        },
      });
      expect(result.success).toBe(true);
    }
  });

  it('should reject parameters over max (50)', () => {
    const params = Array.from({ length: 51 }, (_, i) => ({
      name: `param${i}`,
      type: 'string' as const,
    }));
    const result = scriptBuilderContextSchema.safeParse({
      editorSnapshot: { parameters: params },
    });
    expect(result.success).toBe(false);
  });

  it('should reject timeoutSeconds below 1', () => {
    const result = scriptBuilderContextSchema.safeParse({
      editorSnapshot: { timeoutSeconds: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('should reject timeoutSeconds above 86400', () => {
    const result = scriptBuilderContextSchema.safeParse({
      editorSnapshot: { timeoutSeconds: 86401 },
    });
    expect(result.success).toBe(false);
  });

  it('should accept timeoutSeconds at boundaries', () => {
    expect(
      scriptBuilderContextSchema.safeParse({
        editorSnapshot: { timeoutSeconds: 1 },
      }).success
    ).toBe(true);
    expect(
      scriptBuilderContextSchema.safeParse({
        editorSnapshot: { timeoutSeconds: 86400 },
      }).success
    ).toBe(true);
  });

  it('should reject name over 255 chars in editorSnapshot', () => {
    const result = scriptBuilderContextSchema.safeParse({
      editorSnapshot: { name: 'x'.repeat(256) },
    });
    expect(result.success).toBe(false);
  });

  it('should reject description over 2000 chars in editorSnapshot', () => {
    const result = scriptBuilderContextSchema.safeParse({
      editorSnapshot: { description: 'x'.repeat(2001) },
    });
    expect(result.success).toBe(false);
  });

  it('should reject content over 500000 chars in editorSnapshot', () => {
    const result = scriptBuilderContextSchema.safeParse({
      editorSnapshot: { content: 'x'.repeat(500001) },
    });
    expect(result.success).toBe(false);
  });

  it('should reject options over 1000 chars in parameter', () => {
    const result = scriptBuilderContextSchema.safeParse({
      editorSnapshot: {
        parameters: [
          { name: 'param', type: 'select', options: 'x'.repeat(1001) },
        ],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('createScriptBuilderSessionSchema', () => {
  it('should accept empty object', () => {
    const result = createScriptBuilderSessionSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept session with title and context', () => {
    const result = createScriptBuilderSessionSchema.safeParse({
      title: 'Build a backup script',
      context: {
        scriptId: VALID_UUID,
      },
    });
    expect(result.success).toBe(true);
  });

  it('should reject title over 255 chars', () => {
    const result = createScriptBuilderSessionSchema.safeParse({
      title: 'x'.repeat(256),
    });
    expect(result.success).toBe(false);
  });
});
