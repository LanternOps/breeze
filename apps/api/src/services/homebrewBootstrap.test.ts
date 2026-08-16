import { describe, expect, it } from 'vitest';
import {
  HOMEBREW_INSTALLER_REF,
  HOMEBREW_INSTALLER_SHA256,
  HOMEBREW_INSTALLER_URL,
  homebrewBootstrapPayload,
} from './homebrewBootstrap';

describe('pinned Homebrew installer constants', () => {
  it('pins a 64-char lowercase hex sha256', () => {
    expect(HOMEBREW_INSTALLER_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fetches from raw.githubusercontent.com over https', () => {
    const url = new URL(HOMEBREW_INSTALLER_URL);
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('raw.githubusercontent.com');
  });

  it('points at an immutable ref segment of Homebrew/install, never a moving branch', () => {
    const url = new URL(HOMEBREW_INSTALLER_URL);
    const segments = url.pathname.split('/').filter(Boolean);
    // ['Homebrew', 'install', '<ref>', 'install.sh']
    expect(segments.slice(0, 2)).toEqual(['Homebrew', 'install']);
    expect(segments).toHaveLength(4);
    expect(segments[3]).toBe('install.sh');

    const ref = segments[2]!;
    expect(ref).toBe(HOMEBREW_INSTALLER_REF);
    expect(['HEAD', 'head', 'master', 'main']).not.toContain(ref);
    // Immutable ref: a 40-char commit sha, or a version tag.
    expect(ref).toMatch(/^([0-9a-f]{40}|\d+\.\d+\.\d+)$/);
  });

  it('builds the exact agent payload', () => {
    expect(homebrewBootstrapPayload()).toEqual({
      installerUrl: HOMEBREW_INSTALLER_URL,
      installerSha256: HOMEBREW_INSTALLER_SHA256,
    });
  });
});
