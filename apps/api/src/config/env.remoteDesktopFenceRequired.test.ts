import { afterEach, describe, expect, it } from 'vitest';
import { remoteDesktopFenceRequired } from './env';

// SEC-038 W06 (#5537). REMOTE_DESKTOP_FENCE_REQUIRED gates every desktop-start
// dispatch site on the agent's desktopFenceProtocolVersion capability. Ships
// DEFAULT OFF (owner decision 1: flipped one release after W06) so the release
// that introduces the gate is a no-op for the fleet. Read at CALL time, like
// policyDecideEnabled(), so a test can flip it per-case without resetModules.
describe('remoteDesktopFenceRequired()', () => {
  const original = process.env.REMOTE_DESKTOP_FENCE_REQUIRED;
  afterEach(() => {
    if (original === undefined) delete process.env.REMOTE_DESKTOP_FENCE_REQUIRED;
    else process.env.REMOTE_DESKTOP_FENCE_REQUIRED = original;
  });

  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['0', false],
    ['garbage', false],
    ['true', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['TRUE', true],
  ])('REMOTE_DESKTOP_FENCE_REQUIRED=%s → %s', (raw, expected) => {
    if (raw === undefined) delete process.env.REMOTE_DESKTOP_FENCE_REQUIRED;
    else process.env.REMOTE_DESKTOP_FENCE_REQUIRED = raw;
    expect(remoteDesktopFenceRequired()).toBe(expected);
  });

  it('is read at call time — flipping the env var changes the very next call', () => {
    delete process.env.REMOTE_DESKTOP_FENCE_REQUIRED;
    expect(remoteDesktopFenceRequired()).toBe(false);
    process.env.REMOTE_DESKTOP_FENCE_REQUIRED = 'true';
    expect(remoteDesktopFenceRequired()).toBe(true);
    process.env.REMOTE_DESKTOP_FENCE_REQUIRED = 'false';
    expect(remoteDesktopFenceRequired()).toBe(false);
  });
});
