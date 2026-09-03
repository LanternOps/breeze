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
 * Nothing is invented: if GOOGLE_SERVICES_JSON is unset, this script fails
 * loudly rather than letting `expo prebuild` fail later with a less obvious
 * "file not found", or — worse — silently prebuilding without Firebase config
 * if a stale file happens to exist on disk from a previous run.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = resolve(projectRoot, 'google-services.json');

const raw = process.env.GOOGLE_SERVICES_JSON;
if (!raw) {
  console.error(
    '--- GOOGLE_SERVICES_JSON is not set. Cannot write apps/mobile/google-services.json.\n' +
      '--- Set it to the content of the file downloaded from the Firebase Console\n' +
      '--- (Project Settings -> your Android app -> Download google-services.json),\n' +
      '--- as raw JSON or base64. See STORE_SUBMISSION.md for details.'
  );
  process.exit(1);
}

let contents;
try {
  JSON.parse(raw);
  contents = raw;
} catch {
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    JSON.parse(decoded); // validate before writing — a bad secret should fail loudly here
    contents = decoded;
  } catch {
    console.error(
      '--- GOOGLE_SERVICES_JSON is set but is neither valid JSON nor base64-encoded JSON.'
    );
    process.exit(1);
  }
}

writeFileSync(OUT_PATH, contents, { mode: 0o600 });
console.log(`--- wrote ${OUT_PATH} from GOOGLE_SERVICES_JSON`);
