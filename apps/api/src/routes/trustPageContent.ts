// Owner: W02f (FAQ and subprocessors), mounted at /orgs.
// W02a stub (Trust Center W2, #8770): mounted in index.ts and registered in the auth-gate and MCP-coverage
// contracts so the owning sub-wave adds handlers here without touching a shared file.
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';

export const trustPageContentRoutes = new Hono();
trustPageContentRoutes.use('*', authMiddleware);
