// Device prompt copy and identity: one catalog in eight locales, shared by the
// API, the Go agent (embedded copy) and Breeze Assist (path alias, which takes
// negotiate.ts / sanitize.ts / catalog/*.json directly, never this barrel).
// Spec §3.1 "Who renders copy", §3.6; plan Tasks 3.1–3.4.

// Set zod jitless before any schema is constructed (web CSP; see zodJitlessEntry.test.ts).
import '../validators/topologyZod';

export * from './negotiate';
export * from './sanitize';
export * from './render';
export * from './identity';
