import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyUploadSigning } = require('./androidUploadSigning.js');

// Trimmed from the build.gradle that `expo prebuild` (SDK 57) generates.
const TEMPLATE = `
android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            shrinkResources (findProperty('android.enableShrinkResourcesInReleaseBuilds')?.toBoolean() ?: false)
            minifyEnabled enableProguardInReleaseBuilds
        }
    }
}
`;

describe('withAndroidUploadSigning', () => {
  it('adds a release signing config read from Gradle properties and uses it for release builds', () => {
    const out = applyUploadSigning(TEMPLATE);
    expect(out).toContain("storeFile file(BREEZE_UPLOAD_STORE_FILE)");
    expect(out).toMatch(
      /release \{[^}]*signingConfig project\.hasProperty\('BREEZE_UPLOAD_STORE_FILE'\) \? signingConfigs\.release : signingConfigs\.debug/
    );
    // The debug build type must still sign with the debug key.
    expect(out).toMatch(/debug \{\s*signingConfig signingConfigs\.debug\s*\}/);
  });

  it('is idempotent', () => {
    const once = applyUploadSigning(TEMPLATE);
    expect(applyUploadSigning(once)).toBe(once);
  });

  it('fails loudly when the template shape changed', () => {
    expect(() => applyUploadSigning('android { }')).toThrow(/signingConfigs\.debug/);
  });
});
