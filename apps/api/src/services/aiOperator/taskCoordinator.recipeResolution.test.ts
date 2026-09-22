/**
 * The coordinator's recipe resolution (Recipe Library spec §6.1, wave E1).
 *
 * Pure and exported on purpose: `advanceTask` itself needs a leased row and a
 * live database, and the branch that matters most here — an admitted task
 * whose workflow key or version the registry does not know — must be a
 * classified HANDOFF, never a throw. A throw would leave the BullMQ wake job
 * retrying forever against a row that can never advance, with nothing in the
 * task's own outcome to tell a technician why it stopped.
 *
 * The handoff itself is proved against real Postgres in
 * `src/__tests__/integration/aiOperatorRecipeRegistry.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { resolveTaskRecipe } from './taskCoordinator';

describe('resolveTaskRecipe', () => {
  it('resolves the released service_recovery pair', () => {
    const resolved = resolveTaskRecipe({ workflowKey: 'service_recovery', workflowVersion: 1 });
    expect(resolved.ok).toBe(true);
    expect((resolved as { recipe: { key: string } }).recipe.key).toBe('service_recovery');
  });

  it('refuses an unknown key with a detail naming the key and the version', () => {
    const resolved = resolveTaskRecipe({ workflowKey: 'identity_offboarding', workflowVersion: 1 });
    expect(resolved.ok).toBe(false);
    expect((resolved as { detail: string }).detail).toContain('identity_offboarding');
    expect((resolved as { detail: string }).detail).toContain('1');
  });

  it('refuses a version the registry has not released — a task is never upgraded', () => {
    const resolved = resolveTaskRecipe({ workflowKey: 'service_recovery', workflowVersion: 2 });
    expect(resolved.ok).toBe(false);
    expect((resolved as { detail: string }).detail).toContain('service_recovery');
  });

  it('never throws, whatever it is handed', () => {
    expect(() => resolveTaskRecipe({ workflowKey: '', workflowVersion: 0 })).not.toThrow();
    expect(resolveTaskRecipe({ workflowKey: '', workflowVersion: 0 }).ok).toBe(false);
  });
});
