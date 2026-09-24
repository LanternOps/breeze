import type { Context } from 'hono';

export const LEGACY_ALERTING_GONE = {
  error: 'This endpoint was retired by the alerting consolidation.',
  message: 'Alert conditions are authored as monitors. Create, update and delete through /api/v1/monitor-definitions; attach a monitor to a configuration policy through its "monitors" feature link. Read endpoints for legacy rows remain for alert history.',
  docs: 'https://docs.breezermm.com/features/monitors/',
} as const;

export const legacyAlertingGone = (c: Context) => c.json(LEGACY_ALERTING_GONE, 410);
