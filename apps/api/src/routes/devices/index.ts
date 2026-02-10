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

export const deviceRoutes = new Hono();

// Mount groups routes first (they have /groups prefix that could conflict with /:id)
deviceRoutes.route('/', groupsRoutes);

// Mount filesystem routes before core routes so /:id/filesystem resolves cleanly.
deviceRoutes.route('/', filesystemRoutes);

// Mount core routes (/, /:id, PATCH /:id, DELETE /:id)
deviceRoutes.route('/', coreRoutes);

// Mount sub-resource routes
deviceRoutes.route('/', metricsRoutes);
deviceRoutes.route('/', softwareRoutes);
deviceRoutes.route('/', commandsRoutes);
deviceRoutes.route('/', hardwareRoutes);
deviceRoutes.route('/', alertsRoutes);
deviceRoutes.route('/', patchesRoutes);
deviceRoutes.route('/', scriptsRoutes);
deviceRoutes.route('/', eventsRoutes);
deviceRoutes.route('/', eventLogsRoutes);
deviceRoutes.route('/', sessionsRoutes);

// Re-export helpers and schemas for potential use elsewhere
export * from './helpers';
export * from './schemas';
