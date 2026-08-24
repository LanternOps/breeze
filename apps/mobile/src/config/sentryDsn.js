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
 */

/** The public (bundle-inlined) DSN variable. Not a secret; see .env.example. */
const SENTRY_DSN_VAR = 'EXPO_PUBLIC_SENTRY_DSN';

/** Deliberate opt-out for a release build that should ship without telemetry. */
const ALLOW_NO_SENTRY_VAR = 'BREEZE_MOBILE_ALLOW_NO_SENTRY';

/** Force the release-build path on (for testing the guard itself). */
const FORCE_RELEASE_VAR = 'BREEZE_MOBILE_RELEASE';

/** Matches `scripts/preflight.mjs --dev`: downgrade a local build to non-release. */
const FORCE_DEV_VAR = 'BREEZE_MOBILE_DEV';

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

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Permissive truthiness, used ONLY for flags that make the guard stricter.
 *
 * @param {string | undefined} v
 */
function isTruthy(v) {
  return typeof v === 'string' && TRUTHY.has(v.trim().toLowerCase());
}

/**
 * Strict truthiness — the literal string `1` — for the two flags that SUPPRESS
 * the guard.
 *
 * Two reasons it is not `isTruthy`. It matches the existing convention
 * (`scripts/preflight.mjs` tests `BREEZE_MOBILE_DEV === '1'`), and an
 * unrecognised value fails in the safe direction: `BREEZE_MOBILE_DEV=yes` keeps
 * the guard ON rather than quietly turning it off. A flag that disables a
 * safety check should have the smallest possible accidental-set surface.
 *
 * @param {string | undefined} v
 */
function isSuppressed(v) {
  return v === '1';
}

/** The only environment names EAS accepts. */
const EAS_ENVIRONMENTS = ['development', 'preview', 'production'];

/**
 * Which EAS environment the failure message should tell the user to configure.
 *
 * The guard treats every non-`development` profile as a release, so
 * `eas build --profile preview` can fail here — and a message that named
 * `production` regardless would send them to configure the wrong environment
 * and fail again. Our `eas.json` maps each profile to the environment of the
 * same name; an unrecognised custom profile falls back to `production`.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function easEnvironmentFor(env) {
  const profile = String(env.EAS_BUILD_PROFILE || '').trim().toLowerCase();
  return EAS_ENVIRONMENTS.includes(profile) ? profile : 'production';
}

/**
 * Warnings go straight to stderr, not `console.warn`: `expo config` swallows
 * console output while it evaluates the config (verified — the warning vanished
 * entirely), and a silenced warning about disabled telemetry is the exact
 * failure this whole file exists to prevent.
 *
 * @param {{ warn?: (message: string) => void } | undefined} io
 * @returns {(message: string) => void}
 */
function warnFn(io) {
  return (io && io.warn) || ((message) => process.stderr.write(`${message}\n`));
}

/**
 * Decide whether this config evaluation belongs to a build that will be
 * installed on somebody's phone with `__DEV__ === false`.
 *
 * Returns a human-readable REASON rather than a boolean so the failure message
 * can say why it thinks this is a release build. When someone hits this guard
 * unexpectedly, "which signal fired" is the only question they have.
 *
 * The signals, and why each one is trustworthy:
 *
 *  - `CONFIGURATION` — Xcode exports every build setting into the environment
 *    of a script build phase (`get-app-config-ios.sh` reads
 *    `$CONFIGURATION_BUILD_DIR` the same way). `Release` covers both Archive
 *    and `expo run:ios --configuration Release`.
 *  - `EAS_BUILD_PROFILE` — set by EAS Build. The `development` profile builds a
 *    dev client, which runs the dev bundle and genuinely does not need a DSN;
 *    every other profile (`preview` included) ships a `__DEV__ === false`
 *    bundle to a real device and does need one.
 *  - `NODE_ENV === 'production'` — what `expo export` and the Android release
 *    bundling task run under. Also the mode `@expo/env` uses to pick
 *    `.env.production`.
 *
 * This function deliberately does NOT consider `BREEZE_MOBILE_DEV`. Detection
 * and suppression are separate steps so that suppressing a real signal can be
 * reported — see `releaseBuildReason`.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string | null} reason, or null when this is not a release build
 */
function detectReleaseSignal(env) {
  // Only ever makes the guard stricter, so the permissive spelling is fine.
  if (isTruthy(env[FORCE_RELEASE_VAR])) return `${FORCE_RELEASE_VAR} is set`;

  const configuration = env.CONFIGURATION;
  if (typeof configuration === 'string' && /release/i.test(configuration)) {
    return `Xcode CONFIGURATION="${configuration}"`;
  }

  const profile = env.EAS_BUILD_PROFILE;
  if (typeof profile === 'string' && profile.trim() && !/^development$/i.test(profile.trim())) {
    return `EAS_BUILD_PROFILE="${profile.trim()}"`;
  }

  if (env.NODE_ENV === 'production') return 'NODE_ENV="production"';

  return null;
}

/**
 * `detectReleaseSignal` with the `BREEZE_MOBILE_DEV` escape hatch applied.
 *
 * ORDER MATTERS, and getting it wrong is the bug this shape exists to prevent.
 * The override used to be the first line of the function, returning before any
 * signal was computed — so `BREEZE_MOBILE_DEV=1` on a genuine Release archive
 * disabled the guard and there was nothing left to report. That inverted the
 * design: the flag that fully suppresses the check was silent, while
 * `BREEZE_MOBILE_ALLOW_NO_SENTRY` — which merely opts out of telemetry — was
 * loud.
 *
 * It is a reachable mistake, not a theoretical one. `BREEZE_MOBILE_DEV` is a
 * pre-existing convention from `scripts/preflight.mjs`, and this feature's own
 * documentation tells people to put build variables in `apps/mobile/.env` —
 * the exact file the expo-constants Xcode phase loads on every build. A line
 * left behind in `.env` after some local preflight work would have restored the
 * original silent-blind-release failure.
 *
 * So: compute the signal FIRST, apply the override second, and say so on stderr
 * whenever the override actually suppressed something.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ warn?: (message: string) => void }} [io]
 * @returns {string | null} reason, or null when this is not a release build
 */
function releaseBuildReason(env, io) {
  const signal = detectReleaseSignal(env);
  if (!isSuppressed(env[FORCE_DEV_VAR])) return signal;

  if (signal) {
    warnFn(io)(
      `[breeze] WARNING: ${FORCE_DEV_VAR}=1 is suppressing the release-build ` +
        `${SENTRY_DSN_VAR} check for what looks like a real release build ` +
        `(${signal}). If this is an Archive you intend to ship, remove ` +
        `${FORCE_DEV_VAR} from apps/mobile/.env and your shell — it will ship ` +
        'with crash and error reporting disabled.'
    );
  }

  return null;
}

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

  const reason = releaseBuildReason(env, io);
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
