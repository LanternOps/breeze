import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { configsRoutes } from './configs';
import { policiesRoutes } from './policies';
import { jobsRoutes } from './jobs';
import { snapshotsRoutes } from './snapshots';
import { restoreRoutes } from './restore';
import { dashboardRoutes } from './dashboard';

export const backupRoutes = new Hono();

backupRoutes.use('*', authMiddleware);

backupRoutes.route('/', configsRoutes);
backupRoutes.route('/', policiesRoutes);
backupRoutes.route('/', jobsRoutes);
backupRoutes.route('/', snapshotsRoutes);
backupRoutes.route('/', restoreRoutes);
backupRoutes.route('/', dashboardRoutes);

