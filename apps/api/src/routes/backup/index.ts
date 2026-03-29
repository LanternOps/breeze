import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { configsRoutes } from './configs';
import { jobsRoutes } from './jobs';
import { snapshotsRoutes } from './snapshots';
import { restoreRoutes } from './restore';
import { dashboardRoutes } from './dashboard';
import { backupVerificationRoutes } from './verification';
import { vssRoutes } from './vss';
import { encryptionRoutes } from './encryption';

export const backupRoutes = new Hono();

backupRoutes.use('*', authMiddleware);

backupRoutes.route('/', configsRoutes);
backupRoutes.route('/', jobsRoutes);
backupRoutes.route('/', snapshotsRoutes);
backupRoutes.route('/', restoreRoutes);
backupRoutes.route('/', dashboardRoutes);
backupRoutes.route('/', backupVerificationRoutes);
backupRoutes.route('/vss', vssRoutes);
backupRoutes.route('/encryption', encryptionRoutes);
