// Baked at build time from the PUBLIC_APP_VERSION build-arg (driven by
// BREEZE_VERSION). When unset (local dev / an un-versioned build), fall back to
// the non-semver sentinel 'dev' so the sidebar footer renders a neutral label
// rather than a misleading fake-old '0.1.0' that the staleness check would flag
// red as "update available". Mirrors the API fallback (API_VERSION -> 'dev').
export const WEB_VERSION = import.meta.env.PUBLIC_APP_VERSION || 'dev';
