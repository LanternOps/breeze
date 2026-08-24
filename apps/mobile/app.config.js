const { resolveAssociatedDomains } = require('./src/config/associatedDomains');
const { resolveSentryDsn } = require('./src/config/sentryDsn');

/**
 * Dynamic config layered over `app.json`.
 *
 * This file does two jobs, and the second one is a build gate.
 *
 * 1. `ios.associatedDomains` — a self-hosted build can add its own domain.
 *    Apple binds Associated Domains into the signed entitlement, so the list is
 *    fixed at build time and cannot be a runtime setting — a self-hoster has to
 *    build the app themselves for their domain to associate. The published App
 *    Store build can never cover an arbitrary domain, which is a platform
 *    constraint rather than a gap here.
 *
 *      BREEZE_ASSOCIATED_DOMAINS=breeze.example.com npx expo prebuild -p ios
 *
 *    Accepts several entries separated by commas or whitespace and tolerates a
 *    pasted URL. The hosted regions in `app.json` are always kept, so this can
 *    only add to the list.
 *
 * 2. `extra.sentryDsn` — resolving the DSN here FAILS A RELEASE BUILD that has
 *    none. This file is the right home for that check because `expo-constants`
 *    runs `expo config` from an Xcode script build phase on every single build
 *    (see the long comment in `src/config/sentryDsn.js`), so unlike
 *    `scripts/preflight.mjs` — which is a manual step nobody runs, and which is
 *    why the mobile Sentry project sat at zero events for 90 days — it cannot
 *    be skipped by pressing ⌘B or Archive. Non-release builds are untouched.
 *
 * Plain CommonJS on purpose: Expo transpiles this file but not the modules it
 * requires, so the resolvers next door have to stay `.js` too.
 */
module.exports = ({ config }) => {
  // Runs before the spread so a release build with no DSN fails here, rather
  // than producing a config that quietly ships without telemetry.
  const sentryDsn = resolveSentryDsn(process.env);

  return {
    ...config,
    ios: {
      ...config.ios,
      associatedDomains: resolveAssociatedDomains(
        config.ios && config.ios.associatedDomains,
        process.env.BREEZE_ASSOCIATED_DOMAINS
      ),
    },
    extra: {
      ...config.extra,
      // Second delivery path for the DSN. `EXPO_PUBLIC_*` inlining happens
      // during the Metro transform, a DIFFERENT build phase from the one that
      // evaluates this file, so a value present at config time is not
      // guaranteed to be present at bundle time. App.tsx falls back to this,
      // which ties what actually shipped to what the guard above verified.
      //
      // The key is OMITTED rather than set to null/undefined when there is no
      // DSN. Expo's config serialisation rewrites both into `{}` — verified
      // with `expo config --json --type public` — and `{}` is TRUTHY, so a
      // placeholder key would hand `Sentry.init` an object as its DSN and make
      // a DSN-less dev build look configured. App.tsx also type-checks the
      // value it reads, so this is belt and braces.
      ...(sentryDsn ? { sentryDsn } : {}),
    },
  };
};
