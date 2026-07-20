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
 *   - `webSdkVersion`: the version of `@breeze/extension-web-sdk` this API image
 *     was built against. This same API process serves the web registry
 *     (`/api/v1/extensions/registry`) and web assets
 *     (`/api/v1/extensions/assets/...`) — see Task 3 — and
 *     `assertCompatible`/`checkExtensionCompatibility` is the ONLY compatibility
 *     gate that governs activation, web included; there is no separate web-tier
 *     gate. So the host must advertise the `@breeze/extension-web-sdk` contract
 *     version it was built against, or every manifest with a `web` section (which
 *     mandates `requires.webSdk`) is reported incompatible and never activates.
 *     Pinned as a constant for the same bundling reason as `serverSdkVersion`; kept
 *     in lockstep with packages/extension-web-sdk/package.json ("version") by
 *     review.
 *
 * Capability posture: the host advertises the full SUPPORTED_EXTENSION_CAPABILITIES
 * set. Those constants define the PLATFORM contract the manifest schema validates
 * against, so advertising them means "this platform understands these capability
 * tokens", not "the API tier physically serves each one". The API loader wires the
 * server.* contributions; web.* contributions are wired by the web host.
 *
 * Slot contracts: `slots` names the web extension-point contract versions THIS
 * deployment supports — a separate axis from `webSdkVersion` above (a manifest
 * can satisfy `requires.webSdk` yet still declare a slot this deployment doesn't
 * implement). `device.detail.tabs@1` and `organization.settings.sections@1` are the two
 * contracts the web host currently implements (see plan03-seams.md). A manifest
 * declaring a slot/version not listed here is reported incompatible by
 * `checkExtensionCompatibility` (compatibility.ts). Widen this map only when the
 * web host actually ships support for the new contract version.
 */
export const HOST_API_VERSION = 'breeze.extensions/v1' as const;

/** @see packages/extension-sdk/package.json "version" */
export const HOST_SERVER_SDK_VERSION = '1.0.0';

/** @see apps/api/package.json "version" */
export const HOST_BREEZE_VERSION = '0.1.0';

/** @see packages/extension-web-sdk/package.json "version" */
export const HOST_WEB_SDK_VERSION = '1.0.0';

export const HOST_DESCRIPTOR: ExtensionHostDescriptor = Object.freeze({
  apiVersions: Object.freeze([HOST_API_VERSION]),
  breezeVersion: HOST_BREEZE_VERSION,
  serverSdkVersion: HOST_SERVER_SDK_VERSION,
  webSdkVersion: HOST_WEB_SDK_VERSION,
  capabilities: Object.freeze([...SUPPORTED_EXTENSION_CAPABILITIES]),
  slots: Object.freeze({
    'device.detail.tabs': Object.freeze([1]),
    'organization.settings.sections': Object.freeze([1]),
  }),
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
