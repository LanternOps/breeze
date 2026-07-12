import { describe, expect, it, vi } from 'vitest';
import { runReauthenticationTeardown } from './reauthenticationTeardown';

describe('runReauthenticationTeardown', () => {
  it('dispatches the terminal reset even when SecureStore reports a partial SecureWipeError', async () => {
    const dispatchTerminal = vi.fn();
    const capture = vi.fn();
    const wipeError = Object.assign(new Error('partial wipe'), { name: 'SecureWipeError' });

    await runReauthenticationTeardown(async () => { throw wipeError; }, dispatchTerminal, capture);

    expect(dispatchTerminal).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
  });
});
