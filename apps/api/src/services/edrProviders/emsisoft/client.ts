/** Exact host (index correction 8): no leading dot, so `xapi.emsisoft.com` and `api.emsisoft.com.evil.test` are refused. */
export const EMSISOFT_HOST_ALLOWLIST = ['api.emsisoft.com'] as const;
