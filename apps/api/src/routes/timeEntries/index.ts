import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { timeEntriesApiRoutes } from './timeEntries';

export const timeEntriesRoutes = new Hono();

// authMiddleware at the hub (tickets/index.ts pattern) — requireScope/requirePermission
// in the sub-router depend on c.get('auth') being populated.
timeEntriesRoutes.use('*', authMiddleware);
timeEntriesRoutes.route('/', timeEntriesApiRoutes);
