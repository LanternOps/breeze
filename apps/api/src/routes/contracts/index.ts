import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { contractCrudRoutes } from './contracts';
import { contractLifecycleRoutes } from './lifecycle';
import { contractGenerateRoutes } from './generate';
import { contractLineRoutes } from './lines';
import { contractBulkRoutes } from './bulk';
import { contractTemplateRoutes } from './templates';
import { contractDocumentRoutes } from './documents';

export const contractRoutes = new Hono();
contractRoutes.use('*', authMiddleware);
contractRoutes.route('/', contractBulkRoutes);       // bulk-* before /:id
contractRoutes.route('/contract-templates', contractTemplateRoutes); // /contract-templates/* — before /:id param matchers
contractRoutes.route('/contract-documents', contractDocumentRoutes); // /contract-documents/* — before /:id param matchers
contractRoutes.route('/', contractLifecycleRoutes); // /:id/activate, /:id/pause, /:id/resume, /:id/cancel
contractRoutes.route('/', contractGenerateRoutes);  // /:id/generate
contractRoutes.route('/', contractLineRoutes);       // /:id/lines, /:id/lines/:lineId
contractRoutes.route('/', contractCrudRoutes);       // /, /:id (param matchers last)
