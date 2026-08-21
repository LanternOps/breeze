const { resolveAssociatedDomains } = require('./src/config/associatedDomains');

/**
 * Dynamic config layered over `app.json`.
 *
 * Everything still lives in `app.json`; this exists only so a self-hosted build
 * can add its own domain to `ios.associatedDomains`. Apple binds Associated
 * Domains into the signed entitlement, so the list is fixed at build time and
 * cannot be a runtime setting — a self-hoster has to build the app themselves
 * for their domain to associate. The published App Store build can never cover
 * an arbitrary domain, which is a platform constraint rather than a gap here.
 *
 *   BREEZE_ASSOCIATED_DOMAINS=breeze.example.com npx expo prebuild -p ios
 *
 * Accepts several entries separated by commas or whitespace and tolerates a
 * pasted URL. The hosted regions in `app.json` are always kept, so this can
 * only add to the list.
 *
 * Plain CommonJS on purpose: Expo transpiles this file but not the modules it
 * requires, so the resolver next door has to stay `.js` too.
 */
module.exports = ({ config }) => ({
  ...config,
  ios: {
    ...config.ios,
    associatedDomains: resolveAssociatedDomains(
      config.ios && config.ios.associatedDomains,
      process.env.BREEZE_ASSOCIATED_DOMAINS
    ),
  },
});
