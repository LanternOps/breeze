import { Hono } from 'hono';
import { listRoutes } from './list';

export const thirdPartyCatalogRoutes = new Hono();

thirdPartyCatalogRoutes.route('/', listRoutes);
