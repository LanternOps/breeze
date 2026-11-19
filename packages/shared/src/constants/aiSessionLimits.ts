/**
 * AI chat session lifetime (#11430). A send to a session older than the cap or
 * idle longer than the window is refused with 410. The single owner of these
 * values: the API's rule (`apps/api/src/services/aiAgentSessionLimits.ts`,
 * applied by `aiSessionExpiry.ts`) and the web's resume check
 * (`WispHomeThread.tsx`) both import them from here. Leaf module, no imports.
 */
export const AI_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const AI_SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
