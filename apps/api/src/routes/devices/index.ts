import { Hono } from 'hono';
import { coreRoutes } from './core';
import { metricsRoutes } from './metrics';
import { softwareRoutes } from './software';
import { commandsRoutes } from './commands';
import { hardwareRoutes } from './hardware';
import { alertsRoutes } from './alerts';
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
import { provisionRoutes } from './provision';
import { moveOrgRoutes } from './moveOrg';
import { actuateElevationRoutes } from './actuateElevation';
import { softwareActionsRoutes } from './softwareActions';

export const deviceRoutes = new Hono();

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

// Mount core routes (/, /:id, PATCH /:id, DELETE /:id)
deviceRoutes.route('/', coreRoutes);

// Mount sub-resource routes
deviceRoutes.route('/', metricsRoutes);
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
deviceRoutes.route('/', patchesRoutes);
deviceRoutes.route('/', scriptsRoutes);
deviceRoutes.route('/', eventsRoutes);
deviceRoutes.route('/', eventLogsRoutes);
deviceRoutes.route('/', sessionsRoutes);
deviceRoutes.route('/', diagnosticLogsRoutes);
deviceRoutes.route('/', watchdogLogsRoutes);
deviceRoutes.route('/', warrantyRoutes);
deviceRoutes.route('/', bootMetricsRoutes);
deviceRoutes.route('/', actuateElevationRoutes);

// Re-export helpers and schemas for potential use elsewhere
export * from './helpers';
export * from './schemas';
