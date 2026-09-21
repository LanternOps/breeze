/**
 * Admission resolves its recipe through the registry (Recipe Library spec
 * §6.1, wave E1) instead of hardcoding `SERVICE_RECOVERY_WORKFLOW_KEY` into
 * the insert (`taskService.ts:189-190` before this wave).
 *
 * These cases are all refusals that must land BEFORE the database is touched,
 * so the suite needs no db: reaching Postgres to learn that a workflow does
 * not exist would hold a connection for a request that can never succeed, and
 * would make the refusal depend on tenant state it has nothing to do with.
 * `vi.mock('../../db')` throws on any use, which is what proves the ordering.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: new Proxy({}, { get() { throw new Error('admission touched the database before refusing'); } }),
  runOutsideDbContext: () => { throw new Error('admission opened a db context before refusing'); },
  withSystemDbAccessContext: () => { throw new Error('admission opened a db context before refusing'); },
}));

vi.mock('../../config/env', () => ({
  aiOperatorTasksEnabled: () => true,
  aiOperatorServiceRecoveryEnabled: () => true,
}));

import { admitServiceRecoveryTask } from './taskService';

const DEVICE_ID = '00000000-0000-4000-8000-000000000011';
const ORG_ID = '00000000-0000-4000-8000-000000000001';
const AGENT_ID = '00000000-0000-4000-8000-000000000002';

const base = {
  orgId: ORG_ID,
  agentId: AGENT_ID,
  objective: 'Restore the spooler service',
  originKind: 'manual' as const,
  requesterUserId: null,
  recipeInput: { deviceId: DEVICE_ID, serviceName: 'spooler' },
};

describe('admitServiceRecoveryTask recipe resolution', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('refuses an unknown workflow key with unknown_recipe, before any db work', async () => {
    const result = await admitServiceRecoveryTask({ ...base, workflowKey: 'identity_offboarding' });
    expect(result).toMatchObject({ ok: false, refusal: 'unknown_recipe' });
    expect((result as { detail: string }).detail).toContain('service_recovery');
  });

  it('refuses a workflow version this deployment has not released', async () => {
    const result = await admitServiceRecoveryTask({ ...base, workflowVersion: 99 });
    expect(result).toMatchObject({ ok: false, refusal: 'recipe_version_mismatch' });
    expect((result as { detail: string }).detail).toContain('99');
  });

  it('still refuses invalid recipe input before any db work', async () => {
    const result = await admitServiceRecoveryTask({ ...base, recipeInput: { deviceId: 'nope', serviceName: '' } });
    expect(result).toMatchObject({ ok: false, refusal: 'invalid_input' });
  });
});
