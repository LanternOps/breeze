/**
 * "Is this build going to end up on somebody's phone?" — shared by every
 * build-time guard in `app.config.js`.
 *
 * This started life inside `sentryDsn.js`, which was the first guard to need
 * it. It moved here when `apiUrl.js` became the second: the detection logic and
 * its escape hatch are about the BUILD, not about any one variable, and two
 * copies would have drifted. `sentryDsn.js` re-exports the names it used to own
 * so nothing that imports them had to change.
 *
 * Plain CommonJS on purpose: Expo transpiles `app.config.js` itself but NOT the
 * modules it requires, so everything reachable from there has to stay `.js`.
 */

/** Force the release-build path on (for testing a guard itself). */
const FORCE_RELEASE_VAR = 'BREEZE_MOBILE_RELEASE';

/** Matches `scripts/preflight.mjs --dev`: downgrade a local build to non-release. */
const FORCE_DEV_VAR = 'BREEZE_MOBILE_DEV';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Permissive truthiness, used ONLY for flags that make a guard stricter.
 *
 * @param {string | undefined} v
 */
function isTruthy(v) {
  return typeof v === 'string' && TRUTHY.has(v.trim().toLowerCase());
}

/**
 * Strict truthiness — the literal string `1` — for flags that SUPPRESS a guard.
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
 * Which EAS environment a failure message should tell the user to configure.
 *
 * The guards treat every non-`development` profile as a release, so
 * `eas build --profile preview` can fail — and a message that named
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
 * console output while it evaluates the config — observed on Expo SDK 57, where
 * the warning vanished entirely — and a silenced warning about a suppressed
 * guard is the exact failure these guards exist to prevent. It is a point-in-
 * time finding about a third-party CLI, so re-check it on a major Expo upgrade;
 * nothing in the test suite can hold Expo to it.
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
 * Returns a human-readable REASON rather than a boolean so a failure message
 * can say why it thinks this is a release build. When someone hits a guard
 * unexpectedly, "which signal fired" is the only question they have.
 *
 * The signals, and why each one is trustworthy:
 *
 *  - `CONFIGURATION` — Xcode exports every build setting into the environment
 *    of a script build phase (`get-app-config-ios.sh` reads
 *    `$CONFIGURATION_BUILD_DIR` the same way). `Release` covers both Archive
 *    and `expo run:ios --configuration Release`.
 *  - `EAS_BUILD_PROFILE` — set by EAS Build. The `development` profile builds a
 *    dev client, which runs the dev bundle; every other profile (`preview`
 *    included) ships a `__DEV__ === false` bundle to a real device.
 *  - `NODE_ENV === 'production'` — what `expo export` and the Android release
 *    bundling task run under. Also the mode `@expo/env` uses to pick
 *    `.env.production`. This is the signal that covers a LOCAL Android release
 *    (`./gradlew bundleRelease`), which sets neither `CONFIGURATION` nor
 *    `EAS_BUILD_PROFILE`: the Gradle task shells out to `expo export:embed
 *    --dev false`, and `@expo/cli` does `setNodeEnv('production')` at the top of
 *    `exportEmbedAsync` (build/src/export/embed/exportEmbedAsync.js:208 on SDK
 *    57) — before the `getConfig` call further down that evaluates this config.
 *    `expo run:android --variant release` and `expo run:ios --configuration
 *    Release` set it in their own entry points for the same reason.
 *
 * This function deliberately does NOT consider `BREEZE_MOBILE_DEV`. Detection
 * and suppression are separate steps so that suppressing a real signal can be
 * reported — see `releaseBuildReason`.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string | null} reason, or null when this is not a release build
 */
function detectReleaseSignal(env) {
  // Only ever makes the guards stricter, so the permissive spelling is fine.
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
 * original silent-broken-release failure.
 *
 * So: compute the signal FIRST, apply the override second, and say so on stderr
 * whenever the override actually suppressed something.
 *
 * `checkName` only shapes that warning. It is optional so a caller that just
 * wants the reason (and the tests that assert the ordering) can omit it; when
 * two guards both suppress on the same build, each names itself, which is the
 * point — "which check did I just turn off" is the question being answered.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ warn?: (message: string) => void }} [io]
 * @param {{ checkName?: string, consequence?: string }} [options]
 * @returns {string | null} reason, or null when this is not a release build
 */
function releaseBuildReason(env, io, options) {
  const signal = detectReleaseSignal(env);
  if (!isSuppressed(env[FORCE_DEV_VAR])) return signal;

  if (signal) {
    const checkName = (options && options.checkName) || null;
    const consequence = (options && options.consequence) || null;
    warnFn(io)(
      `[breeze] WARNING: ${FORCE_DEV_VAR}=1 is suppressing the release-build ` +
        `${checkName ? `${checkName} check` : 'checks'} for what looks like a real ` +
        `release build (${signal}). If this is an Archive you intend to ship, ` +
        `remove ${FORCE_DEV_VAR} from apps/mobile/.env and your shell` +
        `${consequence ? ` — ${consequence}` : '.'}`
    );
  }

  return null;
}

module.exports = {
  detectReleaseSignal,
  easEnvironmentFor,
  isSuppressed,
  isTruthy,
  releaseBuildReason,
  warnFn,
  FORCE_DEV_VAR,
  FORCE_RELEASE_VAR,
};
