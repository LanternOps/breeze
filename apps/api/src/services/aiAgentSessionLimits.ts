// AI chat session lifetime limits. A leaf (its only import is the shared
// constants barrel) so code outside the chat runtime can apply the same "live
// session" rule without importing aiAgentSdk.ts and its route graph. The values
// are owned by @breeze/shared (constants/aiSessionLimits.ts, #11430) so the web's
// resume check uses the same numbers; aiSessionExpiry.ts applies them for the
// send pre-flight, the session read, the in-memory eviction and the idle sweep.
// aiAgentSdk.ts re-exports both constants.
import { AI_SESSION_IDLE_TIMEOUT_MS, AI_SESSION_MAX_AGE_MS } from '@breeze/shared/constants';

export const SESSION_MAX_AGE_MS = AI_SESSION_MAX_AGE_MS; // 24 hours
export const SESSION_IDLE_TIMEOUT_MS = AI_SESSION_IDLE_TIMEOUT_MS; // 2 hours
