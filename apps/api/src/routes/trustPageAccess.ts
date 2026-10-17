// Owner: W02d (access requests inbox, approve/deny/revoke, access settings), mounted at /orgs.
// W02a stub (Trust Center W2, #8770): mounted in index.ts and registered in the auth-gate and MCP-coverage
// contracts so the owning sub-wave adds handlers here without touching a shared file.
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';

export const trustPageAccessRoutes = new Hono();
trustPageAccessRoutes.use('*', authMiddleware);
