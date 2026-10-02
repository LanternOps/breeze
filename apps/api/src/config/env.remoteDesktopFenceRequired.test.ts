import { afterEach, describe, expect, it } from 'vitest';
import { remoteDesktopFenceRequired } from './env';

// REMOTE_DESKTOP_FENCE_REQUIRED gates every desktop-start dispatch site on the
// agent's desktopFenceProtocolVersion capability. It shipped default off and is
// now required by default; setting it to a false value is the explicit opt-out.
// Read at CALL time, like policyDecideEnabled(), so a test can flip it per-case
// without resetModules.
describe('remoteDesktopFenceRequired()', () => {
  const original = process.env.REMOTE_DESKTOP_FENCE_REQUIRED;
  afterEach(() => {
    if (original === undefined) delete process.env.REMOTE_DESKTOP_FENCE_REQUIRED;
    else process.env.REMOTE_DESKTOP_FENCE_REQUIRED = original;
  });

  it.each([
    [undefined, true],
    ['', true],
    ['false', false],
    ['0', false],
    ['no', false],
    ['off', false],
    ['garbage', true],
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
    process.env.REMOTE_DESKTOP_FENCE_REQUIRED = 'false';
    expect(remoteDesktopFenceRequired()).toBe(false);
    delete process.env.REMOTE_DESKTOP_FENCE_REQUIRED;
    expect(remoteDesktopFenceRequired()).toBe(true);
    process.env.REMOTE_DESKTOP_FENCE_REQUIRED = 'true';
    expect(remoteDesktopFenceRequired()).toBe(true);
    process.env.REMOTE_DESKTOP_FENCE_REQUIRED = 'false';
    expect(remoteDesktopFenceRequired()).toBe(false);
  });
});
