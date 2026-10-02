/** Every gateway size/time limit, in one place (W06 Global Constraints). W07 reads these. */
export const GATEWAY_MAX_REQUEST_BYTES = 32 * 1024 * 1024;
export const GATEWAY_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const GATEWAY_CONNECT_TIMEOUT_MS = 30_000;
export const GATEWAY_IDLE_TIMEOUT_MS = 120_000;
export const GATEWAY_TOTAL_TIMEOUT_MS = 15 * 60_000;
export const GATEWAY_MAX_CONCURRENT_PER_GRANT = 8;
export const GRANT_DEFAULT_TTL_MS = 30 * 60_000;     // a one-shot or a turn; sessions re-grant per spawn
export const GRANT_SESSION_TTL_MS = 24 * 60 * 60_000; // Agent SDK session lifetime cap (SESSION_MAX_AGE_MS); also the hard TTL ceiling
export const GATEWAY_MAX_TOOLS = 512;
export const GATEWAY_MAX_TOOL_CALLS = 64;
export const GATEWAY_MAX_TOOL_ARGS_BYTES = 256 * 1024;
export const GATEWAY_ERROR_TEXT_MAX = 600;
/** Bytes of an upstream error body the gateway reads before scrubbing (the rest is discarded unread). */
export const GATEWAY_UPSTREAM_ERROR_READ_BYTES = 4 * 1024;
export const DISCOVERY_MAX_RESPONSE_BYTES = 1024 * 1024;
export const DISCOVERY_MAX_MODELS = 500;
