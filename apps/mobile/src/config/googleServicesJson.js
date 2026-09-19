/**
 * Parsing + shape validation for the GOOGLE_SERVICES_JSON build secret (#3639).
 *
 * Pulled out of scripts/write-google-services.mjs so the accept-raw-or-base64
 * logic and the shape check are unit-tested, mirroring how apiUrl.js separates
 * the decision logic (tested via apiUrl.test.ts) from the untested orchestration
 * shell in scripts/preflight.mjs — vitest's include pattern only covers
 * `src/**\/*.test.ts`, not `scripts/**`, so logic worth pinning has to live here.
 *
 * `JSON.parse` alone only proves the secret is *some* JSON value — it does not
 * prove it is a real google-services.json. A plausible mixup (e.g. pasting the
 * server's FIREBASE_SERVICE_ACCOUNT service-account JSON here instead — the
 * script's own docs draw that exact parallel) would otherwise pass silently and
 * get written to disk, moving the failure to a much later and less obvious point
 * (a native Firebase-init crash deep into `expo prebuild`/a Gradle build).
 * Checking for `project_info.project_id`, a non-empty `client[]`, and — when an
 * Android package name is present at all — that it matches this app's
 * `com.breeze.rmm` catches that class of mistake here instead, loudly, with the
 * secret's actual name in the message.
 */

const EXPECTED_ANDROID_PACKAGE = 'com.breeze.rmm';

class GoogleServicesJsonError extends Error {}

/**
 * Validates and normalizes the GOOGLE_SERVICES_JSON secret into the exact file
 * contents to write. Accepts either raw JSON or base64-encoded JSON (same
 * tolerance as apps/api/src/services/fcm.ts's FIREBASE_SERVICE_ACCOUNT
 * parsing). Throws GoogleServicesJsonError with a human-readable reason for
 * every invalid input; never returns a value that hasn't passed the shape
 * check below.
 */
function parseGoogleServicesJson(raw) {
  if (!raw) {
    throw new GoogleServicesJsonError('GOOGLE_SERVICES_JSON is not set');
  }

  let parsed;
  let contents;
  try {
    parsed = JSON.parse(raw);
    contents = raw;
  } catch {
    let decoded;
    try {
      decoded = Buffer.from(raw, 'base64').toString('utf8');
      parsed = JSON.parse(decoded);
    } catch {
      throw new GoogleServicesJsonError(
        'GOOGLE_SERVICES_JSON is neither valid JSON nor base64-encoded JSON'
      );
    }
    contents = decoded;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GoogleServicesJsonError(
      'GOOGLE_SERVICES_JSON parsed but is not a JSON object — not a real google-services.json'
    );
  }

  const projectId = parsed.project_info && parsed.project_info.project_id;
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new GoogleServicesJsonError(
      'GOOGLE_SERVICES_JSON is missing project_info.project_id — not a real google-services.json'
    );
  }

  if (!Array.isArray(parsed.client) || parsed.client.length === 0) {
    throw new GoogleServicesJsonError(
      'GOOGLE_SERVICES_JSON has no client[] entries — not a real google-services.json'
    );
  }

  const packageNames = parsed.client
    .map((c) => c?.client_info?.android_client_info?.package_name)
    .filter((name) => typeof name === 'string' && name.length > 0);
  if (packageNames.length > 0 && !packageNames.includes(EXPECTED_ANDROID_PACKAGE)) {
    throw new GoogleServicesJsonError(
      `GOOGLE_SERVICES_JSON has no client for package "${EXPECTED_ANDROID_PACKAGE}" ` +
        `(found: ${packageNames.join(', ')}) — check you downloaded the right Firebase Android app`
    );
  }

  return contents;
}

module.exports = { parseGoogleServicesJson, GoogleServicesJsonError, EXPECTED_ANDROID_PACKAGE };
