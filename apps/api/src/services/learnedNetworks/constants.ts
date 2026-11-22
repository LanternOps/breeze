/**
 * Learned networks (#12369) limits and windows. Spec
 * docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md §6;
 * index contract E2. Later waves add to this file.
 */
export const NETWORK_ATTACHMENT_FRESHNESS_MS = 10 * 60_000;
export const NETWORK_ATTACHMENT_MAX_CAPTURE_SKEW_MS = 10 * 60_000;
export const LEARNED_NETWORKS_PER_ORG_MAX = 5_000;
export const WAN_ADDRESSES_PER_NETWORK_MAX = 32;
export const UNASSIGNED_NETWORK_RETENTION_DAYS = 90;
export const NETWORK_DEVICE_RETENTION_DAYS = 90;
export const SUGGESTION_WINDOW_DAYS = 14;
export const SUGGESTION_MIN_SITE_DEVICES = 2;
export const CROSS_NETWORK_WINDOW_DAYS = 30;
