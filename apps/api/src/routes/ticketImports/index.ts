import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { ticketImportRunRoutes } from './runs';
import { ticketImportSourceRoutes } from './sources';

/**
 * /ticket-imports (#8313 W4; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §5.7): connect a source, map it, check it, and run dry runs and imports.
 * Partner scope, partner-wide admins only; the namespace is reserved in the
 * extension SDK. Windows are opened and closed through /migration-windows.
 */
export const ticketImportRoutes = new Hono();

ticketImportRoutes.use('*', authMiddleware);
ticketImportRoutes.route('/', ticketImportSourceRoutes);
ticketImportRoutes.route('/', ticketImportRunRoutes);
