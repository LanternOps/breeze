import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { statusRoutes } from './status';
import { threatsRoutes } from './threats';
import { scansRoutes } from './scans';
import { policiesRoutes } from './policies';
import { dashboardRoutes } from './dashboard';
import { postureRoutes } from './posture';
import { complianceRoutes } from './compliance';
import { recommendationsRoutes } from './recommendations';

export const securityRoutes = new Hono();

securityRoutes.use('*', authMiddleware);

securityRoutes.route('/', statusRoutes);
securityRoutes.route('/', threatsRoutes);
securityRoutes.route('/', scansRoutes);
securityRoutes.route('/', policiesRoutes);
securityRoutes.route('/', dashboardRoutes);
securityRoutes.route('/', postureRoutes);
securityRoutes.route('/', complianceRoutes);
securityRoutes.route('/', recommendationsRoutes);

