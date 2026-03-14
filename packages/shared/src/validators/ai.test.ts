import { describe, it, expect } from 'vitest';
import {
  aiPageContextSchema,
  createAiSessionSchema,
  sendAiMessageSchema,
  approveToolSchema,
  approvePlanSchema,
  aiApprovalModeSchema,
  pauseAiSchema,
  aiSessionQuerySchema,
  scriptBuilderContextSchema,
  createScriptBuilderSessionSchema,
} from './ai';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

// ============================================
// Page Context
// ============================================

describe('aiPageContextSchema', () => {
  it('should accept device context', () => {
    const result = aiPageContextSchema.safeParse({
      type: 'device',
      id: VALID_UUID,
      hostname: 'web-server-01',
    });
    expect(result.success).toBe(true);
  });

  it('should accept device context with all optional fields', () => {
    const result = aiPageContextSchema.safeParse({
      type: 'device',
      id: VALID_UUID,
      hostname: 'web-server-01',
      os: 'Windows 11',
      status: 'online',
      ip: '192.168.1.10',
    });
    expect(result.success).toBe(true);
  });

  it('should reject device context without required hostname', () => {
    const result = aiPageContextSchema.safeParse({
      type: 'device',
      id: VALID_UUID,
    });
    expect(result.success).toBe(false);
  });

  it('should reject device context with invalid UUID', () => {
    const result = aiPageContextSchema.safeParse({
      type: 'device',
      id: 'not-a-uuid',
      hostname: 'server',
    });
    expect(result.success).toBe(false);
  });

  it('should accept alert context', () => {
    const result = aiPageContextSchema.safeParse({
      type: 'alert',
      id: VALID_UUID,
      title: 'High CPU Usage',
    });
    expect(result.success).toBe(true);
  });

  it('should accept alert context with optional fields', () => {
    const result = aiPageContextSchema.safeParse({
      type: 'alert',
      id: VALID_UUID,
      title: 'Disk Full',
      severity: 'critical',
      deviceHostname: 'db-server-01',
    });
    expect(result.success).toBe(true);
  });

  it('should reject alert context without title', () => {
    const result = aiPageContextSchema.safeParse({
      type: 'alert',
      id: VALID_UUID,
    });
    expect(result.success).toBe(false);
  });

  it('should accept dashboard context', () => {
    const result = aiPageContextSchema.safeParse({
      type: 'dashboard',
    });
    expect(result.success).toBe(true);
  });

  it('should accept dashboard context with all fields', () => {
    const result = aiPageContextSchema.safeParse({
      type: 'dashboard',
      orgName: 'Acme Corp',
      deviceCount: 150,
      alertCount: 3,
    });
    expect(result.success).toBe(true);
  });

  it('should accept custom context', () => {
    const result = aiPageContextSchema.safeParse({
      type: 'custom',
      label: 'Script Editor',
      data: { scriptId: '123', language: 'powershell' },
    });
    expect(result.success).toBe(true);
  });

  it('should reject custom context without label', () => {
    const result = aiPageContextSchema.safeParse({
      type: 'custom',
      data: {},
    });
    expect(result.success).toBe(false);
  });

  it('should reject custom context without data', () => {
    const result = aiPageContextSchema.safeParse({
      type: 'custom',
      label: 'Test',
    });
    expect(result.success).toBe(false);
  });

  it('should reject unknown context type', () => {
    const result = aiPageContextSchema.safeParse({
      type: 'unknown',
      id: VALID_UUID,
    });
    expect(result.success).toBe(false);
  });
});

// ============================================
// Session Schemas
// ============================================

describe('createAiSessionSchema', () => {
  it('should accept empty object (all optional)', () => {
    const result = createAiSessionSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept session with all fields', () => {
    const result = createAiSessionSchema.safeParse({
      pageContext: { type: 'dashboard' },
      model: 'claude-3-opus',
      title: 'Help with server issue',
    });
    expect(result.success).toBe(true);
  });

  it('should reject model over 100 chars', () => {
    const result = createAiSessionSchema.safeParse({
      model: 'x'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('should reject title over 255 chars', () => {
    const result = createAiSessionSchema.safeParse({
      title: 'x'.repeat(256),
    });
    expect(result.success).toBe(false);
  });

  it('should accept valid page context', () => {
    const result = createAiSessionSchema.safeParse({
      pageContext: {
        type: 'device',
        id: VALID_UUID,
        hostname: 'server-01',
      },
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid page context', () => {
    const result = createAiSessionSchema.safeParse({
      pageContext: { type: 'invalid' },
    });
    expect(result.success).toBe(false);
  });
});

describe('sendAiMessageSchema', () => {
  it('should accept valid message', () => {
    const result = sendAiMessageSchema.safeParse({
      content: 'What is the CPU usage on server-01?',
    });
    expect(result.success).toBe(true);
  });

  it('should accept message with page context', () => {
    const result = sendAiMessageSchema.safeParse({
      content: 'Restart this service',
      pageContext: {
        type: 'device',
        id: VALID_UUID,
        hostname: 'server-01',
      },
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty content', () => {
    const result = sendAiMessageSchema.safeParse({
      content: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject content over 10000 chars', () => {
    const result = sendAiMessageSchema.safeParse({
      content: 'x'.repeat(10001),
    });
    expect(result.success).toBe(false);
  });

  it('should accept content at exactly 10000 chars', () => {
    const result = sendAiMessageSchema.safeParse({
      content: 'x'.repeat(10000),
    });
    expect(result.success).toBe(true);
  });

  it('should accept content at exactly 1 char', () => {
    const result = sendAiMessageSchema.safeParse({
      content: 'x',
    });
    expect(result.success).toBe(true);
  });

  it('should reject missing content', () => {
    const result = sendAiMessageSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('approveToolSchema', () => {
  it('should accept approved: true', () => {
    const result = approveToolSchema.safeParse({ approved: true });
    expect(result.success).toBe(true);
  });

  it('should accept approved: false', () => {
    const result = approveToolSchema.safeParse({ approved: false });
    expect(result.success).toBe(true);
  });

  it('should reject non-boolean', () => {
    const result = approveToolSchema.safeParse({ approved: 'yes' });
    expect(result.success).toBe(false);
  });

  it('should reject missing approved field', () => {
    const result = approveToolSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('approvePlanSchema', () => {
  it('should accept approved: true', () => {
    const result = approvePlanSchema.safeParse({ approved: true });
    expect(result.success).toBe(true);
  });

  it('should accept approved: false', () => {
    const result = approvePlanSchema.safeParse({ approved: false });
    expect(result.success).toBe(true);
  });

  it('should reject non-boolean', () => {
    const result = approvePlanSchema.safeParse({ approved: 1 });
    expect(result.success).toBe(false);
  });
});

describe('aiApprovalModeSchema', () => {
  it('should accept all valid modes', () => {
    const modes = ['per_step', 'action_plan', 'auto_approve', 'hybrid_plan'] as const;
    for (const mode of modes) {
      const result = aiApprovalModeSchema.safeParse(mode);
      expect(result.success).toBe(true);
    }
  });

  it('should reject invalid mode', () => {
    const result = aiApprovalModeSchema.safeParse('full_auto');
    expect(result.success).toBe(false);
  });

  it('should reject empty string', () => {
    const result = aiApprovalModeSchema.safeParse('');
    expect(result.success).toBe(false);
  });
});

describe('pauseAiSchema', () => {
  it('should accept paused: true', () => {
    const result = pauseAiSchema.safeParse({ paused: true });
    expect(result.success).toBe(true);
  });

  it('should accept paused: false', () => {
    const result = pauseAiSchema.safeParse({ paused: false });
    expect(result.success).toBe(true);
  });

  it('should reject non-boolean', () => {
    const result = pauseAiSchema.safeParse({ paused: 'true' });
    expect(result.success).toBe(false);
  });
});

// ============================================
// Query Schemas
// ============================================

describe('aiSessionQuerySchema', () => {
  it('should accept empty query (all optional)', () => {
    const result = aiSessionQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept all valid status values', () => {
    const statuses = ['active', 'closed', 'expired'] as const;
    for (const status of statuses) {
      const result = aiSessionQuerySchema.safeParse({ status });
      expect(result.success).toBe(true);
    }
  });

  it('should accept page and limit as strings', () => {
    const result = aiSessionQuerySchema.safeParse({ page: '2', limit: '25' });
    expect(result.success).toBe(true);
  });

  it('should reject invalid status', () => {
    const result = aiSessionQuerySchema.safeParse({ status: 'deleted' });
    expect(result.success).toBe(false);
  });
});

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
