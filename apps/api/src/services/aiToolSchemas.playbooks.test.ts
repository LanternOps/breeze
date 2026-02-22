import { describe, expect, it } from 'vitest';
import { validateToolInput } from './aiToolSchemas';

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

describe('aiToolSchemas playbook tools', () => {
  it('validates list_playbooks input', () => {
    const ok = validateToolInput('list_playbooks', { category: 'disk' });
    expect(ok.success).toBe(true);

    const bad = validateToolInput('list_playbooks', { category: 'unknown' });
    expect(bad.success).toBe(false);
  });

  it('validates execute_playbook required fields', () => {
    const ok = validateToolInput('execute_playbook', {
      playbookId: UUID_A,
      deviceId: UUID_B,
      variables: { serviceName: 'nginx' },
    });
    expect(ok.success).toBe(true);

    const missing = validateToolInput('execute_playbook', {
      playbookId: UUID_A,
    });
    expect(missing.success).toBe(false);
  });

  it('enforces get_playbook_history limit bounds and status enum', () => {
    const ok = validateToolInput('get_playbook_history', {
      status: 'completed',
      limit: 50,
    });
    expect(ok.success).toBe(true);

    const badStatus = validateToolInput('get_playbook_history', {
      status: 'done',
    });
    expect(badStatus.success).toBe(false);

    const badLimit = validateToolInput('get_playbook_history', {
      limit: 101,
    });
    expect(badLimit.success).toBe(false);
  });
});
