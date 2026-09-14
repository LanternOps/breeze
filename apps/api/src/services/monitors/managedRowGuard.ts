import type { Context } from 'hono';

// #5289 (+ network_monitors, #5291 W04) — rows carrying a
// managed_by_monitor_id are COMPILED from a monitor definition by
// monitorCompiler.ts, which must be the row's only writer. If any other
// writer (REST route, AI tool) accepted a side edit to a managed row, that
// edit would silently drift from the monitor definition it was compiled from
// until the next compile pass overwrote it without warning — the tech's
// change would appear to work, then vanish. Refusing the write up front
// keeps the compiled row and its source definition in lockstep at all times.
export const MANAGED_BY_MONITOR_ERROR = {
  automations: 'automation_managed_by_monitor',
  alert_rules: 'alert_rule_managed_by_monitor',
  alert_templates: 'alert_template_managed_by_monitor',
  // #5291 W04 — a `network_check` monitor compiles to a FOURTH managed row.
  // Without this the legacy network-monitor CRUD surface could repoint a
  // compiled probe's target, which would survive only until the next compile.
  network_monitors: 'network_monitor_managed_by_monitor',
} as const;

export function managedByMonitorResponse(
  c: Context,
  table: keyof typeof MANAGED_BY_MONITOR_ERROR,
  monitorId: string,
) {
  return c.json({ error: MANAGED_BY_MONITOR_ERROR[table], monitorId }, 409);
}
