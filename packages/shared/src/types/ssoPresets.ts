// OIDC provider preset ids (#9601). Single source of truth for the key the web
// SSO form sends as `preset` and the key the API's PROVIDER_PRESETS table (and
// GET /sso/presets `id`) is indexed by. The web dropdown once hard-coded
// 'azure' while the API table said 'azure-ad', so picking Azure AD autofilled
// nothing and the create route silently ignored the preset. Both sides are now
// typed against this tuple, so a mismatch fails typecheck instead of shipping.
export const SSO_OIDC_PRESET_IDS = ['azure-ad', 'okta', 'google', 'auth0'] as const;

export type SsoOidcPresetId = (typeof SSO_OIDC_PRESET_IDS)[number];
