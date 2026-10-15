import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isBiometricPromptActive,
  subscribeBiometricPrompt,
  withBiometricPrompt,
} from './biometricPromptState';

describe('biometric prompt registry', () => {
  const unsubs: Array<() => void> = [];
  afterEach(() => {
    unsubs.splice(0).forEach((u) => u());
  });

  it('is active only while a wrapped prompt is in flight', async () => {
    let release!: (v: string) => void;
    const p = withBiometricPrompt(() => new Promise<string>((r) => (release = r)));
    expect(isBiometricPromptActive()).toBe(true);
    release('ok');
    await expect(p).resolves.toBe('ok');
    expect(isBiometricPromptActive()).toBe(false);
  });

  it('ends the prompt when the wrapped call rejects', async () => {
    await expect(withBiometricPrompt(() => Promise.reject(new Error('cancel')))).rejects.toThrow(
      'cancel'
    );
    expect(isBiometricPromptActive()).toBe(false);
  });

  it('ends the prompt when the wrapped call throws synchronously', async () => {
    await expect(
      withBiometricPrompt(() => {
        throw new Error('bridge');
      })
    ).rejects.toThrow('bridge');
    expect(isBiometricPromptActive()).toBe(false);
  });

  it('notifies only on the idle <-> active edges for overlapping prompts', async () => {
    const seen: boolean[] = [];
    unsubs.push(subscribeBiometricPrompt((active) => seen.push(active)));
    let a!: () => void;
    let b!: () => void;
    const pa = withBiometricPrompt(() => new Promise<void>((r) => (a = r)));
    const pb = withBiometricPrompt(() => new Promise<void>((r) => (b = r)));
    a();
    await pa;
    expect(isBiometricPromptActive()).toBe(true);
    b();
    await pb;
    expect(seen).toEqual([true, false]);
  });

  it('stops notifying after unsubscribe', async () => {
    const listener = vi.fn();
    const unsub = subscribeBiometricPrompt(listener);
    unsub();
    await withBiometricPrompt(async () => undefined);
    expect(listener).not.toHaveBeenCalled();
  });
});
