import { ensureActiveSigningKey, signManifest } from './manifestSigning';
import { validateReleaseManifest } from '../routes/agentVersions';

// Round-trip self-test: generate-or-load the active deployment signing key,
// sign a synthetic manifest, then run it through the same validator the
// /agent-versions/:v/download handler uses. If anything in the chain is
// misconfigured (encryption key missing, validator mismatch, schema drift),
// this throws and aborts API startup — the alternative is silently shipping
// rows that all 409 at agent-update time, which is the v0.65.8 regression
// (#625) this self-test is meant to prevent.
export async function runManifestSelfTest(): Promise<void> {
  await ensureActiveSigningKey();

  const manifestObj = {
    version: '0.0.0-selftest',
    component: 'agent',
    platform: 'linux',
    arch: 'amd64',
    url: 'http://selftest.local/agent',
    checksum: 'a'.repeat(64),
    size: 0,
  };
  const manifest = JSON.stringify(manifestObj);
  const signature = await signManifest(manifest);

  const result = await validateReleaseManifest({
    manifest,
    signature,
    version: manifestObj.version,
    platform: manifestObj.platform,
    arch: manifestObj.arch,
    component: manifestObj.component,
    downloadUrl: manifestObj.url,
    checksum: manifestObj.checksum,
    fileSize: manifestObj.size,
  });

  if (!result.ok) {
    throw new Error(
      `[binarySync] manifest signing self-test failed: ${result.reason}. ` +
        `BINARY_SOURCE=local cannot serve agent updates with the current ` +
        `configuration — refusing to start. Check APP_ENCRYPTION_KEY, ` +
        `manifest_signing_keys table contents, and that no env var is ` +
        `pinning a stale RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS that excludes ` +
        `the deployment key.`,
    );
  }

  console.log('[binarySync] Manifest signing self-test passed');
}
