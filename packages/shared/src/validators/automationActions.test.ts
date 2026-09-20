import { describe, it, expect } from 'vitest';
import { automationActionSchema, createAutomationSchema } from './index';

const UUID = '11111111-1111-1111-1111-111111111111';

describe('automationActionSchema - deploy_software', () => {
  it('accepts a valid deploy_software action', () => {
    const parsed = automationActionSchema.safeParse({
      type: 'deploy_software',
      catalogId: UUID,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects deploy_software without a uuid catalogId', () => {
    const parsed = automationActionSchema.safeParse({
      type: 'deploy_software',
      catalogId: 'not-a-uuid',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('createAutomationSchema.actions wiring', () => {
  const base = { name: 'A', trigger: { type: 'schedule', cron: '0 0 * * *' } };

  it('still accepts the pre-existing action shapes (backward compat)', () => {
    const parsed = createAutomationSchema.safeParse({
      ...base,
      actions: [
        { type: 'run_script', scriptId: UUID },
        { type: 'send_notification', notificationChannelId: UUID, severity: 'critical' },
        { type: 'create_alert', alertSeverity: 'high', alertMessage: 'x' },
        { type: 'execute_command', command: 'echo hi', shell: 'bash' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a deploy_software action through the real create path', () => {
    const parsed = createAutomationSchema.safeParse({
      ...base,
      actions: [{ type: 'deploy_software', catalogId: UUID }],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an action with an unknown type', () => {
    const parsed = createAutomationSchema.safeParse({
      ...base,
      actions: [{ type: 'not_a_real_action' }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('automationActionSchema - ai_triage', () => {
  it('accepts the bare ai_triage action', () => {
    const parsed = automationActionSchema.safeParse({ type: 'ai_triage' });
    expect(parsed.success).toBe(true);
  });

  it('rejects ai_triage with an agentId because the arm is strict', () => {
    const parsed = automationActionSchema.safeParse({ type: 'ai_triage', agentId: 'x' });
    expect(parsed.success).toBe(false);
  });

  it('accepts an ai_triage action through the real create path', () => {
    const parsed = createAutomationSchema.safeParse({
      name: 'A',
      trigger: { type: 'schedule', cron: '0 0 * * *' },
      actions: [{ type: 'ai_triage' }],
    });
    expect(parsed.success).toBe(true);
  });
});

// #5128 W4 — offline behaviour on the two device-command action types.
describe('automationActionSchema - whenOffline', () => {
  const SCRIPT_ID = '11111111-2222-4333-8444-555555555555';

  it('defaults run_script whenOffline to queue', () => {
    const parsed = automationActionSchema.safeParse({ type: 'run_script', scriptId: SCRIPT_ID });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ whenOffline: 'queue' });
  });

  it('defaults execute_command whenOffline to queue', () => {
    const parsed = automationActionSchema.safeParse({ type: 'execute_command', command: 'whoami' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ whenOffline: 'queue' });
  });

  it('accepts an explicit skip', () => {
    const parsed = automationActionSchema.safeParse({
      type: 'run_script', scriptId: SCRIPT_ID, whenOffline: 'skip',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ whenOffline: 'skip' });
  });

  it('rejects a value outside the enum', () => {
    const parsed = automationActionSchema.safeParse({
      type: 'execute_command', command: 'whoami', whenOffline: 'defer',
    });
    expect(parsed.success).toBe(false);
  });

  it('carries whenOffline through the real create path', () => {
    const parsed = createAutomationSchema.safeParse({
      name: 'A',
      trigger: { type: 'schedule', cron: '0 0 * * *' },
      actions: [{ type: 'run_script', scriptId: SCRIPT_ID, whenOffline: 'skip' }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.actions[0]).toMatchObject({ whenOffline: 'skip' });
  });
});

describe('automationActionSchema - restart_service', () => {
  it.each([{ maxAttempts: 0, cooldownSeconds: 30 }, { maxAttempts: 50, cooldownSeconds: 86400 }])('accepts restart bounds %j', (limits) => {
    expect(automationActionSchema.parse({ type: 'execute_command', command: 'restart target', ...limits })).toMatchObject(limits);
  });

  it.each([{ maxAttempts: -1 }, { maxAttempts: 51 }, { maxAttempts: 1.5 }, { cooldownSeconds: 29 }, { cooldownSeconds: 86401 }])('rejects invalid restart bounds %j', (limits) => {
    expect(automationActionSchema.safeParse({ type: 'execute_command', command: 'restart target', ...limits }).success).toBe(false);
  });

  it('preserves restart parameters', () => {
    const response = { type: 'execute_command', kind: 'restart_service', command: 'restart target', maxAttempts: 7, cooldownSeconds: 120 };
    expect(automationActionSchema.parse(response)).toMatchObject(response);
  });
});

describe('automationActionSchema - agent-local restart', () => {
  it.each([undefined, '', '   '])('accepts restart_service with command %j', (command) => {
    expect(automationActionSchema.safeParse({ type: 'execute_command', kind: 'restart_service', command }).success).toBe(true);
  });

  it.each([undefined, '', '   '])('rejects ordinary execute_command with command %j', (command) => {
    expect(automationActionSchema.safeParse({ type: 'execute_command', command }).success).toBe(false);
  });
});
