import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HOST_BREEZE_VERSION,
  HOST_DESCRIPTOR,
  HOST_SERVER_SDK_VERSION,
} from './hostDescriptor';

/**
 * hostDescriptor.ts pins the host's advertised versions as literal constants,
 * because the API image is bundled and cannot reliably read a package.json at
 * runtime. Its doc comment names the source of truth for each constant:
 *
 *   - HOST_SERVER_SDK_VERSION → packages/extension-sdk/package.json "version"
 *   - HOST_BREEZE_VERSION     → apps/api/package.json "version"
 *
 * "Kept in lockstep by review" is not a control. A stale constant makes every
 * `requires.serverSdk` / `requires.breeze` compatibility verdict wrong in BOTH
 * directions: a good bundle gets rejected, or an incompatible one gets admitted.
 * These tests read the real package.json files (never a hardcoded copy of the
 * number) so any drift fails here instead of shipping.
 */
function packageVersion(relativeToThisFile: string): string {
  const url = new URL(relativeToThisFile, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'));
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${relativeToThisFile} has no usable "version" field`);
  }
  return version;
}

describe('host descriptor version constants', () => {
  it('HOST_SERVER_SDK_VERSION matches packages/extension-sdk/package.json', () => {
    expect(HOST_SERVER_SDK_VERSION).toBe(
      packageVersion('../../../../packages/extension-sdk/package.json'),
    );
  });

  it('HOST_BREEZE_VERSION matches apps/api/package.json', () => {
    expect(HOST_BREEZE_VERSION).toBe(packageVersion('../../package.json'));
  });

  it('advertises those same constants on the frozen descriptor', () => {
    // Guards the wiring as well as the values: a constant kept current but no
    // longer referenced by HOST_DESCRIPTOR would leave compatibility checks
    // reading a stale number from somewhere else.
    expect(HOST_DESCRIPTOR.serverSdkVersion).toBe(HOST_SERVER_SDK_VERSION);
    expect(HOST_DESCRIPTOR.breezeVersion).toBe(HOST_BREEZE_VERSION);
  });
});
