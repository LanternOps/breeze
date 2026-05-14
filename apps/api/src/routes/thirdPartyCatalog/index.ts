import { Hono } from 'hono';
import { listRoutes } from './list';
import { operationsRoutes } from './operations';

export const thirdPartyCatalogRoutes = new Hono();

thirdPartyCatalogRoutes.route('/', listRoutes);
thirdPartyCatalogRoutes.route('/', operationsRoutes);
