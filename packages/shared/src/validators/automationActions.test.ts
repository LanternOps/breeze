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
