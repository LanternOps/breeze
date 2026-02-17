import { Hono } from 'hono';
import { coreRoutes } from './core';
import { runsRoutes } from './runs';
import { dataRoutes } from './data';
import { generateRoutes } from './generate';

export const reportRoutes = new Hono();

// Mount data and generate routes first (they have /data/* and /generate prefixes
// that could conflict with /:id in core routes)
reportRoutes.route('/', dataRoutes);
reportRoutes.route('/', generateRoutes);
reportRoutes.route('/', runsRoutes);
reportRoutes.route('/', coreRoutes);

