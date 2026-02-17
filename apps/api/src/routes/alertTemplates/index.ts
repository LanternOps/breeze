import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { templateRoutes } from './templates';
import { ruleRoutes } from './rules';
import { correlationRoutes } from './correlations';

export const alertTemplateRoutes = new Hono();

alertTemplateRoutes.use('*', authMiddleware);

alertTemplateRoutes.route('/', templateRoutes);
alertTemplateRoutes.route('/', ruleRoutes);
alertTemplateRoutes.route('/', correlationRoutes);
