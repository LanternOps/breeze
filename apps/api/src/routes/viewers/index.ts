import { Hono } from 'hono';
import { viewerDownloadRoutes } from './download';

export const viewerRoutes = new Hono();

viewerRoutes.route('/', viewerDownloadRoutes);
