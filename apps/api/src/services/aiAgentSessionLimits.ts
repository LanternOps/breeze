// AI chat session lifetime limits. A dependency-free leaf so code outside the
// chat runtime (the AI model registry reconcile, #7600) can apply the same
// "live session" rule without importing aiAgentSdk.ts and its route graph.
// aiAgentSdk.ts re-exports both constants.

export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
