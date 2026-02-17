import { Hono } from 'hono';
import { registerRoutes } from './register';
import { loginRoutes } from './login';
import { mfaRoutes } from './mfa';
import { phoneRoutes } from './phone';
import { passwordRoutes } from './password';

export const authRoutes = new Hono();

// NO global middleware — auth routes have mixed public/authenticated endpoints.
// Each route file applies authMiddleware per-endpoint as needed.

authRoutes.route('/', registerRoutes);
authRoutes.route('/', loginRoutes);
authRoutes.route('/', mfaRoutes);
authRoutes.route('/', phoneRoutes);
authRoutes.route('/', passwordRoutes);

