import { Hono } from 'hono';
import { coreRoutes } from './core';
import { runsRoutes } from './runs';
import { dataRoutes } from './data';
import { generateRoutes } from './generate';
import { recipientsRoutes } from './recipients';
import { reportSeriesRoutes } from './series';

export const reportRoutes = new Hono();

// Multi-org report series (W02) go first: `/series` and `/series/:id` would
// otherwise reach core's `/:id` handlers.
reportRoutes.route('/series', reportSeriesRoutes);
// Mount data and generate routes first (they have /data/* and /generate prefixes
// that could conflict with /:id in core routes)
reportRoutes.route('/', dataRoutes);
reportRoutes.route('/', generateRoutes);
reportRoutes.route('/', runsRoutes);
reportRoutes.route('/', recipientsRoutes);
reportRoutes.route('/', coreRoutes);
