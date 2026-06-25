import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { applyPendingUpdate, dismissPendingUpdate } from './updateActions';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe('updateActions', () => {
  it('applyPendingUpdate invokes the apply command', async () => {
    await applyPendingUpdate();
    expect(invoke).toHaveBeenCalledWith('apply_pending_update');
  });

  it('dismissPendingUpdate invokes the dismiss command', async () => {
    await dismissPendingUpdate();
    expect(invoke).toHaveBeenCalledWith('dismiss_pending_update');
  });
});
