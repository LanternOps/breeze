#!/usr/bin/env node
/**
 * Writes apps/mobile/google-services.json from a build-time secret (#3639).
 *
 * WHY THIS EXISTS
 * ----------------
 * `app.json`'s `android.googleServicesFile` points at `./google-services.json`,
 * and Expo's Android config plugin only resolves that path during
 * `expo prebuild --platform android` (or an EAS/Gradle Android build) — it is
 * never read by `vitest`/`tsc`, so its absence is invisible until someone
 * actually builds for Android.
 *
 * Unlike the iOS `.p8` APNs key (never committed, configured directly in the
 * droplet's `APNS_*` env vars — see STORE_SUBMISSION.md), Android's equivalent
 * credential is a whole JSON file that a native build tool reads off disk, not
 * a single env var a request handler reads at runtime. This script is the
 * translation layer: it takes one build-time secret and writes the file
 * `expo prebuild` expects, the same shape as `ci_post_clone.sh` writing
 * `.env.sentry-build-plugin` from `SENTRY_AUTH_TOKEN` before an iOS build.
 *
 * The file is NOT committed (see apps/mobile/.gitignore) — build-time
 * injection was chosen over committing it so the real project's Firebase
 * config never lands in git history, mirroring how `.p8`/`.p12`/`.mobileprovision`
 * are handled for iOS.
 *
 * USAGE
 * -----
 * Set GOOGLE_SERVICES_JSON to the downloaded file's content (Firebase Console
 * → Project Settings → your Android app → "Download google-services.json"),
 * either as the raw JSON text or base64-encoded (both are accepted, same
 * tolerance as apps/api/src/services/fcm.ts's FIREBASE_SERVICE_ACCOUNT parsing
 * — base64 avoids shell/CI-secret-store quoting issues with raw JSON). Then:
 *
 *   pnpm --filter breeze-mobile write-google-services
 *   npx expo prebuild --platform android
 *
 * Nothing is invented: if GOOGLE_SERVICES_JSON is unset, unparsable, or valid
 * JSON that isn't shaped like a real google-services.json (see
 * src/config/googleServicesJson.js — a bare "is it JSON" check would silently
 * accept e.g. a pasted FIREBASE_SERVICE_ACCOUNT by mistake), this script fails
 * loudly and leaves any existing google-services.json on disk untouched,
 * rather than writing garbage that only surfaces as a native Firebase-init
 * crash deep into `expo prebuild`/a Gradle build. It does NOT detect a stale
 * file left on disk from a previous run when it is never invoked at all —
 * that is a build-pipeline responsibility, not this script's.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GoogleServicesJsonError, parseGoogleServicesJson } from '../src/config/googleServicesJson.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = resolve(projectRoot, 'google-services.json');

try {
  const contents = parseGoogleServicesJson(process.env.GOOGLE_SERVICES_JSON);
  writeFileSync(OUT_PATH, contents, { mode: 0o600 });
  console.log(`--- wrote ${OUT_PATH} from GOOGLE_SERVICES_JSON`);
} catch (err) {
  const message = err instanceof GoogleServicesJsonError ? err.message : String(err);
  console.error(
    `--- ${message}\n` +
      '--- See STORE_SUBMISSION.md for how to set GOOGLE_SERVICES_JSON.'
  );
  process.exit(1);
}
