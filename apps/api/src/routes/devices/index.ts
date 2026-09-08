import { Hono } from 'hono';
import { coreRoutes } from './core';
import { metricsRoutes } from './metrics';
import { processSamplesRoutes } from './processSamples';
import { softwareRoutes } from './software';
import { commandsRoutes } from './commands';
import { hardwareRoutes } from './hardware';
import { alertsRoutes } from './alerts';
import { anomaliesRoutes } from './anomalies';
import { groupsRoutes } from './groups';
import { patchesRoutes } from './patches';
import { scriptsRoutes } from './scripts';
import { eventsRoutes } from './events';
import { eventLogsRoutes } from './eventlogs';
import { filesystemRoutes } from './filesystem';
import { sessionsRoutes } from './sessions';
import { diagnosticLogsRoutes } from './diagnosticLogs';
import { watchdogLogsRoutes } from './watchdogLogs';
import { bootMetricsRoutes } from './bootMetrics';
import { diagnoseRoutes } from './diagnose';
import { warrantyRoutes } from './warranty';
import { billingRoutes } from './billing';
import { provisionRoutes } from './provision';
import { moveOrgRoutes } from './moveOrg';
import { actuateElevationRoutes } from './actuateElevation';
import { softwareActionsRoutes } from './softwareActions';
import { homebrewBootstrapRoutes } from './homebrewBootstrap';
import { networkRoutes } from './network';
import { manualRoutes } from './manual';
import { customFieldValuesRoutes } from './customFieldValues';
import { customFieldImportRoutes } from './customFieldImport';
import { linksRoutes } from './links';
import { statsRoutes } from './stats';
import { postureRoutes } from './posture';
import { optionsRoutes } from './options';
import { healthRoutes } from './health';
import { removalConfigRoutes } from './removalConfig';
import { bulkLifecycleRoutes } from './bulkLifecycle';
import { agentRollbackRoutes } from '../agentRollback';

export const deviceRoutes = new Hono();

// Mount the custom-field VALUE routes FIRST. They use per-route auth that also
// accepts an X-API-Key header (issue #2066). Hono attaches a sibling sub-router's
// `.use('*', authMiddleware)` to every route mounted AFTER it, so mounting these
// after the session-only `coreRoutes` would shadow the API-key branch with the
// JWT-only `authMiddleware` and resurrect the 401. Mounting first keeps them
// clear of every later wildcard auth middleware.
deviceRoutes.route('/', customFieldValuesRoutes);

// Mount the RMM custom-field VALUE importer (#3257 W08) immediately after them,
// and BEFORE coreRoutes. Two reasons, both pinned by
// customFieldImport.mountorder.test.ts:
//  - `/custom-fields/import*` is a static path that must not be reached through
//    any later `/:id` matcher.
//  - This router uses PER-ROUTE auth and must never grow a `.use('*')`: a
//    wildcard here would attach to every route mounted after it, and — mounted
//    where it is — would be the same #2066 shadowing of the API-key branch that
//    the comment above exists to prevent.
deviceRoutes.route('/', customFieldImportRoutes);

// Mount the server-backed selector before coreRoutes so the static `/options`
// path cannot be consumed by core's `GET /:id` matcher.
deviceRoutes.route('/', optionsRoutes);

deviceRoutes.route('/', healthRoutes);

// Mount provision routes FIRST — `/provision` is a static path under /devices
// that must NOT be eaten by the `/:id` matcher in coreRoutes.
deviceRoutes.route('/', provisionRoutes);

// Mount diagnose routes (POST /:id/diagnose)
deviceRoutes.route('/', diagnoseRoutes);

// Mount groups routes first (they have /groups prefix that could conflict with /:id)
deviceRoutes.route('/', groupsRoutes);

// Mount filesystem routes before core routes so /:id/filesystem resolves cleanly.
deviceRoutes.route('/', filesystemRoutes);

// Mount move-org BEFORE core routes — its POST /:id/move-org would collide
// with any future :id-prefixed match in core if registered after.
deviceRoutes.route('/', moveOrgRoutes);

// Mount the network arm of the unified Devices list (#1322) BEFORE core
// routes — `GET /network` is a static path that must not be eaten by the
// `/:id` matcher in coreRoutes.
deviceRoutes.route('/', networkRoutes);

// Mount the manual arm of the unified Devices list (#4622 W02) BEFORE core
// routes — `GET /manual` (and its `/manual/:id/*` children) are static/
// static-prefixed paths that must not be eaten by the `/:id` matcher in
// coreRoutes.
deviceRoutes.route('/', manualRoutes);

// Mount linked-device-profile routes (#2138) BEFORE core — the static
// `/link-groups` paths must not be eaten by the `/:id` matcher in coreRoutes.
deviceRoutes.route('/', linksRoutes);

// Mount fleet stats BEFORE core routes — `GET /stats` is a static path that
// must not be eaten by the `/:id` matcher in coreRoutes.
deviceRoutes.route('/', statsRoutes);

// Mount the fleet posture report (#3244) BEFORE core routes — the static
// `/management-posture/*` paths must not be eaten by the `/:id` matcher
// (which would read `management-posture` as a device id).
deviceRoutes.route('/', postureRoutes);

// Mount the high-power literal sub-resource before core's /:id routes.
deviceRoutes.route('/', agentRollbackRoutes);

// Mount the Remove-dialog config BEFORE core — `/removal-config` is a static
// path that must not be eaten by the `/:id` matcher in coreRoutes.
deviceRoutes.route('/', removalConfigRoutes);

// Mount the bulk lifecycle routes (#2787) BEFORE core — every one of their
// paths starts with the static segment `bulk`, which core's `/:id` matcher
// would otherwise eat (`POST /devices/bulk/restore` would reach core's
// `POST /:id/restore` with the literal id "bulk" and 404). Pinned by
// bulkLifecycle.mountorder.test.ts.
deviceRoutes.route('/', bulkLifecycleRoutes);

// Mount core routes (/, /:id, PATCH /:id, DELETE /:id)
deviceRoutes.route('/', coreRoutes);

// Mount sub-resource routes
deviceRoutes.route('/', metricsRoutes);
deviceRoutes.route('/', processSamplesRoutes);
// Mount softwareActionsRoutes BEFORE softwareRoutes so the POST /:id/software/update
// + /:id/software/uninstall handlers are registered ahead of any future
// software.ts handlers that might shadow them. Different verbs today (POST vs
// the existing GET /:id/software) means there's no actual conflict, but ordering
// the more-specific paths first matches the existing static-before-:id convention.
deviceRoutes.route('/', softwareActionsRoutes);
deviceRoutes.route('/', softwareRoutes);
deviceRoutes.route('/', commandsRoutes);
deviceRoutes.route('/', hardwareRoutes);
deviceRoutes.route('/', alertsRoutes);
deviceRoutes.route('/', anomaliesRoutes);
deviceRoutes.route('/', patchesRoutes);
deviceRoutes.route('/', scriptsRoutes);
deviceRoutes.route('/', eventsRoutes);
deviceRoutes.route('/', eventLogsRoutes);
deviceRoutes.route('/', sessionsRoutes);
deviceRoutes.route('/', diagnosticLogsRoutes);
deviceRoutes.route('/', watchdogLogsRoutes);
deviceRoutes.route('/', warrantyRoutes);
// #3205 W06: GET /:id/billing. :id-prefixed, so it cannot be shadowed by core's
// /:id matcher — mounted here with the other sub-resources, and pinned by
// index.test.ts so a later static sibling cannot silently reorder it.
deviceRoutes.route('/', billingRoutes);
deviceRoutes.route('/', bootMetricsRoutes);
deviceRoutes.route('/', actuateElevationRoutes);
deviceRoutes.route('/', homebrewBootstrapRoutes);

// Re-export helpers and schemas for potential use elsewhere
export * from './helpers';
export * from './schemas';
