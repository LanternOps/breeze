/**
 * Build-time enforcement that a release build actually has a Sentry DSN.
 *
 * WHY THIS EXISTS
 * ---------------
 * The `breeze-mobile` Sentry project recorded zero events in 90 days. Nothing
 * was broken — the app was simply built without `EXPO_PUBLIC_SENTRY_DSN`, and
 * `Sentry.init({ enabled: false })` neither throws nor logs. Every
 * `captureException` in this app has been writing to a closed valve, including
 * the ones covering failures that have no UI at all.
 *
 * A guard for exactly this already existed (`scripts/preflight.mjs`) and it was
 * never wrong — it was just never RUN. It is a manual `pnpm preflight` step
 * documented in STORE_SUBMISSION.md, and the real release path is a human
 * pressing Product → Archive in Xcode, which skips it. A check that a human has
 * to remember is not a check.
 *
 * WHY app.config.js CANNOT BE SKIPPED
 * -----------------------------------
 * `expo-constants` installs an Xcode script build phase (see its podspec:
 * `execution_position => :before_compile`, `always_out_of_date = "1"`) that runs
 * `expo-constants/scripts/getAppConfig.js` on EVERY build of the app — ⌘B,
 * Run, and Archive alike. That script does `require('@expo/env').load(root)`
 * and then `getConfig(root)`, which evaluates `app.config.js`. `expo prebuild`
 * and every Metro bundle evaluate it too.
 *
 * Android has no such config phase, but its release bundling task
 * (`bundleReleaseJsAndAssets` -> `expo export:embed`) calls `getConfig` too —
 * `@expo/cli/build/src/export/embed/exportEmbedAsync.js`. So iOS is covered
 * twice (config phase and bundle phase) and Android once, on the phase that
 * produces the shipped bundle either way.
 *
 * So a throw from here fails the build with a readable message, from inside the
 * same mechanism that produces the app's own config. There is no "I forgot to
 * run the script" path left. That is the whole point: the
 * missing SENTRY_AUTH_TOKEN already self-enforced this way (it fails the
 * archive from a build phase) — the DSN, which is the variable that actually
 * decides whether events exist, had no enforcement at all.
 *
 * Deliberately plain CommonJS, not TypeScript, for the same reason as
 * `associatedDomains.js`: Expo transpiles `app.config.js` itself but NOT the
 * modules it requires, so a `.ts` file here fails at `expo config` /
 * `expo prebuild` time with "Cannot find module".
 *
 * The "is this a release build?" half of this file now lives in
 * `releaseBuild.js`, because `apiUrl.js` guards a second variable through the
 * same hook and two copies of that logic would drift. The names this module
 * used to own are re-exported below so callers and tests did not have to move.
 */

const {
  detectReleaseSignal,
  easEnvironmentFor,
  isSuppressed,
  releaseBuildReason,
  warnFn,
  FORCE_DEV_VAR,
  FORCE_RELEASE_VAR,
} = require('./releaseBuild');

/** The public (bundle-inlined) DSN variable. Not a secret; see .env.example. */
const SENTRY_DSN_VAR = 'EXPO_PUBLIC_SENTRY_DSN';

/** Deliberate opt-out for a release build that should ship without telemetry. */
const ALLOW_NO_SENTRY_VAR = 'BREEZE_MOBILE_ALLOW_NO_SENTRY';

/**
 * Substrings that mean "somebody left the example value in place".
 *
 * A placeholder that passed the check would be worse than no check: the build
 * would succeed, `Sentry.init` would accept a syntactically-valid DSN, and
 * events would be posted to a host that does not exist. Kept lowercase; the
 * comparison lowercases the candidate.
 */
const PLACEHOLDER_MARKERS = [
  'replace_me',
  'replaceme',
  'changeme',
  'change_me',
  'your-dsn',
  'your_dsn',
  'yourdsn',
  'example.com',
  'placeholder',
  'todo',
  'xxxxx',
  '<',
  '>',
];

/**
 * Describe what is wrong with a DSN value, or null when it is usable.
 *
 * Format checks stay deliberately loose — hostname and project segment are not
 * pattern-matched beyond "present" — because a false rejection here breaks a
 * release build for someone running self-hosted Sentry, and the failure mode we
 * are actually defending against is "empty" and "still the example value", not
 * "subtly malformed".
 *
 * @param {string | undefined | null} value
 * @returns {string | null}
 */
function describeDsnProblem(value) {
  if (typeof value !== 'string' || !value.trim()) return 'is not set';

  const dsn = value.trim();
  const lower = dsn.toLowerCase();

  for (const marker of PLACEHOLDER_MARKERS) {
    if (lower.includes(marker)) {
      return `still holds a placeholder value (${JSON.stringify(dsn)})`;
    }
  }

  const invalid = `is not a valid Sentry DSN (${JSON.stringify(dsn)}); expected https://<publicKey>@<host>/<projectId>`;

  let url;
  try {
    url = new URL(dsn);
  } catch {
    return invalid;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return invalid;
  if (!url.username) return invalid; // the public key
  if (!url.hostname) return invalid;

  const projectId = url.pathname.split('/').filter(Boolean).pop();
  if (!projectId) return invalid;

  return null;
}

/**
 * @param {string} problem
 * @param {string} reason
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function buildFailureMessage(problem, reason, env) {
  const easEnvironment = easEnvironmentFor(env);
  return [
    `${SENTRY_DSN_VAR} ${problem} — refusing to build.`,
    '',
    `This is a release build (${reason}), and a release build without a DSN ships`,
    'with crash and error reporting SILENTLY disabled: Sentry.init({ enabled: false })',
    'does not throw, does not log, and there is no console to read in TestFlight.',
    'That is how this app went 90 days without recording a single event.',
    '',
    'Set it in the place the build actually reads:',
    '',
    `  • Local Xcode build — put ${SENTRY_DSN_VAR}=<dsn> in apps/mobile/.env`,
    '    (copy .env.example). Xcode build phases do NOT inherit your interactive',
    '    shell, so exporting it in .zshrc and pressing Archive will not work.',
    '',
    `  • EAS build — store it in the EAS "${easEnvironment}" environment referenced`,
    '    by eas.json:',
    `      eas env:create --environment ${easEnvironment} --name ${SENTRY_DSN_VAR} --value <dsn>`,
    '',
    'The DSN is in Sentry → olivetech-ks → breeze-mobile → Settings → Client Keys',
    '(DSN). It is a write-only client key and ships inside the IPA either way, so',
    'it is not a secret — but it is a live endpoint, so keep it out of git.',
    '',
    `To build a release deliberately WITHOUT telemetry, set ${ALLOW_NO_SENTRY_VAR}=1.`,
  ].join('\n');
}

/**
 * Resolve the DSN for the current build, failing the build when a release is
 * about to ship blind.
 *
 * Returns the DSN so the caller can put it in `expo.extra` — that gives the
 * running app a second delivery path. `EXPO_PUBLIC_*` inlining happens during
 * Metro transform, a DIFFERENT build phase from the one that evaluates this
 * file, so a value present here is not automatically present there. Reading
 * `extra` at runtime closes that gap and ties what shipped to what was checked.
 *
 * Non-release builds are a silent no-op and return `undefined`, exactly as
 * before — local dev, `expo start`, `expo prebuild` and CI must not be broken
 * by this. The dev-loop warning lives in App.tsx.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ warn?: (message: string) => void }} [io]
 * @returns {string | undefined} the validated DSN, or undefined when there is none
 * @throws {Error} on a release build with a missing or placeholder DSN
 */
function resolveSentryDsn(env, io) {
  const raw = env[SENTRY_DSN_VAR];
  const problem = describeDsnProblem(raw);
  if (!problem) return String(raw).trim();

  const reason = releaseBuildReason(env, io, {
    checkName: SENTRY_DSN_VAR,
    consequence: 'it will ship with crash and error reporting disabled.',
  });
  if (!reason) return undefined;

  if (isSuppressed(env[ALLOW_NO_SENTRY_VAR])) {
    warnFn(io)(
      `[breeze] WARNING: ${SENTRY_DSN_VAR} ${problem}, but ${ALLOW_NO_SENTRY_VAR} is set. ` +
        `Building a release (${reason}) with crash and error reporting disabled. ` +
        'Nothing this build does will ever appear in Sentry.'
    );
    return undefined;
  }

  throw new Error(buildFailureMessage(problem, reason, env));
}

module.exports = {
  resolveSentryDsn,
  releaseBuildReason,
  detectReleaseSignal,
  describeDsnProblem,
  SENTRY_DSN_VAR,
  ALLOW_NO_SENTRY_VAR,
  FORCE_RELEASE_VAR,
  FORCE_DEV_VAR,
};
