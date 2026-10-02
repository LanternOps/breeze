import { expect, it, vi } from 'vitest';
import { runAction } from './runAction';
it('surfaces HTTP 200 false success and transport errors', async () => {
  const onOutcome = vi.fn();
  const value = await runAction({ request: async () => ({ data: { success: false }, statusCode: 200 }),
    onOutcome, successMessage: 'Saved', errorFallback: 'Not saved' });
  expect(value).toBeNull(); expect(onOutcome).toHaveBeenLastCalledWith('Not saved', true);
  await runAction({ request: async () => { throw new Error('offline'); }, onOutcome,
    successMessage: 'Saved', errorFallback: 'Not saved' });
  expect(onOutcome).toHaveBeenLastCalledWith('Not saved', true);
});
