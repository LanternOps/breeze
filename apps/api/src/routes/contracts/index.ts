import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { contractPeriodRoutes } from './periods';
import { contractDeliverableRoutes } from './deliverables';
import { contractCrudRoutes } from './contracts';
import { contractLifecycleRoutes } from './lifecycle';
import { contractGenerateRoutes } from './generate';
import { contractLineRoutes } from './lines';
import { contractHourPeriodRoutes } from './hourPeriods';
import { contractBulkRoutes } from './bulk';
import { contractTemplateRoutes } from './templates';
import { contractDocumentRoutes } from './documents';
import { agreementRequestRoutes } from './agreementRequests';
import { contractReportRoutes } from './reports';

export const contractRoutes = new Hono();
contractRoutes.use('*', authMiddleware);
contractRoutes.route('/', contractBulkRoutes);       // bulk-* before /:id
contractRoutes.route('/contract-templates', contractTemplateRoutes); // /contract-templates/* — before /:id param matchers
contractRoutes.route('/contract-documents', contractDocumentRoutes); // /contract-documents/* — before /:id param matchers
contractRoutes.route('/agreement-requests', agreementRequestRoutes); // /agreement-requests/* (#8865) — before /:id param matchers
contractRoutes.route('/', contractReportRoutes);   // /currency-mismatches — literal path, before /:id param matchers
contractRoutes.route('/', contractLifecycleRoutes); // /:id/activate, /:id/pause, /:id/resume, /:id/cancel
contractRoutes.route('/', contractGenerateRoutes);  // /:id/generate
contractRoutes.route('/', contractLineRoutes);       // /:id/lines, /:id/lines/:lineId
contractRoutes.route('/', contractHourPeriodRoutes); // /:id/hour-periods (#4547 W03) — before the /:id param matchers
contractRoutes.route('/', contractPeriodRoutes);     // /:id/periods/:periodId/outcome (#3205 W07)
contractRoutes.route('/', contractDeliverableRoutes); // /:id/deliverables (#5573 W01)
contractRoutes.route('/', contractCrudRoutes);       // /, /:id (param matchers last)
