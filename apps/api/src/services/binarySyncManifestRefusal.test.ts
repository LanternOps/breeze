import { describe, expect, it } from 'vitest';
import { classifyManifestRefusal } from './binarySync';
import {
  ReleaseAssetNotDistributableError,
  ReleaseManifestAssetAbsentError,
  ReleaseManifestAssetLookupError,
  ReleaseManifestSignatureError,
} from './releaseArtifactManifest';

/**
 * BREEZE-1Z: `manifest_refusal_reason` is the whole triage payload of the D4
 * fail-closed change — `scrubEvent` deletes the descriptive message, so this
 * tag is what tells an operator whether a refusal is the INTENDED unsigned
 * darwin case or a real trust regression.
 *
 * It is derived from the thrown error's CLASS, which makes it silently fragile
 * in one specific way: reshuffling the class hierarchy (or reordering the
 * instanceof chain, since ReleaseManifestAssetAbsentError extends
 * ReleaseManifestAssetLookupError) would collapse every refusal to
 * `unclassified` with nothing else failing. Pin the mapping.
 */
describe('classifyManifestRefusal (BREEZE-1Z)', () => {
  it('maps each manifest error class to its own bounded reason', () => {
    expect(classifyManifestRefusal(new ReleaseAssetNotDistributableError('x')))
      .toBe('not-distributable');
    expect(classifyManifestRefusal(new ReleaseManifestAssetLookupError('x')))
      .toBe('manifest-entry-invalid');
    expect(classifyManifestRefusal(new ReleaseManifestSignatureError('x')))
      .toBe('manifest-signature-invalid');
  });

  it('classifies the absent subclass as a lookup failure, not as unclassified', () => {
    // ReleaseManifestAssetAbsentError extends ReleaseManifestAssetLookupError.
    // registerFromOfficialManifest filters it out before reporting, so this
    // never reaches Sentry in practice — but if the instanceof chain were ever
    // reordered so the subclass fell through, this pins that it still lands in
    // a named bucket rather than silently becoming `unclassified`.
    expect(classifyManifestRefusal(new ReleaseManifestAssetAbsentError('x')))
      .toBe('manifest-entry-invalid');
  });

  it('falls back to a named bucket for anything unrecognised', () => {
    // Never throws and never returns an unbounded value, whatever it is handed:
    // this runs on the failure path of a release-artifact refusal.
    expect(classifyManifestRefusal(new Error('plain'))).toBe('unclassified');
    expect(classifyManifestRefusal('a bare string')).toBe('unclassified');
    expect(classifyManifestRefusal(undefined)).toBe('unclassified');
    expect(classifyManifestRefusal(null)).toBe('unclassified');
    expect(classifyManifestRefusal({ message: 'not an Error' })).toBe('unclassified');
  });

  it('returns values that survive the Sentry tag bounds', () => {
    for (const err of [
      new ReleaseAssetNotDistributableError('x'),
      new ReleaseManifestAssetLookupError('x'),
      new ReleaseManifestSignatureError('x'),
      new Error('x'),
    ]) {
      const reason = classifyManifestRefusal(err);
      expect(reason.length).toBeLessThanOrEqual(128);
      expect(reason).not.toMatch(/[/?#\r\n]/);
    }
  });
});
