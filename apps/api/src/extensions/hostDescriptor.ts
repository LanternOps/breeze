import {
  SUPPORTED_EXTENSION_CAPABILITIES,
  type ExtensionManifestV1,
} from '@breeze/extension-sdk';
import {
  checkExtensionCompatibility,
  type ExtensionHostDescriptor,
} from './compatibility';
import { ExtensionIncompatibleError } from './errors';

/**
 * The single, clearly-commented source of truth for what THIS host advertises to
 * the extension compatibility check. There is deliberately no other place that
 * hardcodes these numbers.
 *
 * Version sources (a real design decision — see task-4 report):
 *   - `apiVersions`: the one manifest API this platform speaks, taken from the
 *     `'breeze.extensions/v1'` literal the SDK manifest schema pins (and the same
 *     value loader.ts stamps on synthesized legacy manifests). NOT invented here.
 *   - `serverSdkVersion`: the version of `@breeze/extension-sdk` this API image is
 *     built against — the SDK is the server-side contract surface. Pinned as a
 *     constant here because the package is bundled (no reliable runtime
 *     package.json read in the CJS image); it is kept in lockstep with
 *     packages/extension-sdk/package.json ("version") by review.
 *   - `breezeVersion`: this API build's own version (apps/api/package.json),
 *     pinned for the same bundling reason. A manifest's `requires.breeze` range is
 *     satisfied against this.
 *   - `webSdkVersion`: intentionally undefined. The API tier serves no web assets,
 *     so it advertises no web SDK version; a manifest that `requires.webSdk` is
 *     reported incompatible here, which is correct at the API tier (the web host
 *     owns that half of the contract).
 *
 * Capability posture: the host advertises the full SUPPORTED_EXTENSION_CAPABILITIES
 * set. Those constants define the PLATFORM contract the manifest schema validates
 * against, so advertising them means "this platform understands these capability
 * tokens", not "the API tier physically serves each one". The API loader wires the
 * server.* contributions; web.* contributions are wired by the web host. Slots are
 * a separate, versioned negotiation the API tier does not participate in, so
 * `slots` is empty and a manifest declaring web slots is reported incompatible
 * until web-host slot wiring lands.
 */
export const HOST_API_VERSION = 'breeze.extensions/v1' as const;

/** @see packages/extension-sdk/package.json "version" */
export const HOST_SERVER_SDK_VERSION = '1.0.0';

/** @see apps/api/package.json "version" */
export const HOST_BREEZE_VERSION = '0.1.0';

export const HOST_DESCRIPTOR: ExtensionHostDescriptor = Object.freeze({
  apiVersions: Object.freeze([HOST_API_VERSION]),
  breezeVersion: HOST_BREEZE_VERSION,
  serverSdkVersion: HOST_SERVER_SDK_VERSION,
  webSdkVersion: undefined,
  capabilities: Object.freeze([...SUPPORTED_EXTENSION_CAPABILITIES]),
  slots: Object.freeze({}),
});

/**
 * Throwing wrapper over the pure {@link checkExtensionCompatibility}. The pure
 * function returns a verdict; the reconciler wants a phase that either passes or
 * throws an {@link ExtensionIncompatibleError} (which `recordSanitizedFailure`
 * maps to lifecycle_state 'incompatible').
 */
export function assertCompatible(
  manifest: ExtensionManifestV1,
  host: ExtensionHostDescriptor,
): void {
  const result = checkExtensionCompatibility(manifest, host);
  if (!result.compatible) {
    throw new ExtensionIncompatibleError(result.reasons);
  }
}
