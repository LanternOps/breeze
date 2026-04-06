import { Hono } from 'hono';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { configsRoutes } from './configs';
import { jobsRoutes } from './jobs';
import { snapshotsRoutes } from './snapshots';
import { restoreRoutes } from './restore';
import { dashboardRoutes } from './dashboard';
import { backupVerificationRoutes } from './verification';
import { vssRoutes } from './vss';
import { encryptionRoutes } from './encryption';
import { bmrRoutes, bmrPublicRoutes } from './bmr';
import { vmRestoreRoutes } from './vmrestore';
import { mssqlRoutes } from './mssql';
import { hypervRoutes } from './hyperv';
import { slaRoutes } from './sla';
import { vaultRoutes } from './vault';

export const backupRoutes = new Hono();

// Public recovery endpoints (token-based auth, no JWT required).
// Must be mounted BEFORE the authMiddleware wildcard.
backupRoutes.route('/', bmrPublicRoutes);

backupRoutes.use('*', authMiddleware);
backupRoutes.use('*', requireScope('organization', 'partner', 'system'));

backupRoutes.route('/', configsRoutes);
backupRoutes.route('/', jobsRoutes);
backupRoutes.route('/', snapshotsRoutes);
backupRoutes.route('/', restoreRoutes);
backupRoutes.route('/', dashboardRoutes);
backupRoutes.route('/', backupVerificationRoutes);
backupRoutes.route('/', bmrRoutes);
backupRoutes.route('/', vmRestoreRoutes);
backupRoutes.route('/', mssqlRoutes);
backupRoutes.route('/hyperv', hypervRoutes);
backupRoutes.route('/vss', vssRoutes);
backupRoutes.route('/encryption', encryptionRoutes);
backupRoutes.route('/sla', slaRoutes);
backupRoutes.route('/vault', vaultRoutes);
