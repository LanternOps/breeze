import { Hono } from 'hono';
import { registerRoutes } from './register';
import { loginRoutes } from './login';
import { mfaRoutes } from './mfa';
import { phoneRoutes } from './phone';
import { passwordRoutes } from './password';
import { inviteRoutes } from './invite';
import { verifyEmailRoutes } from './verifyEmail';
import { accountDeletionRoutes } from './accountDeletion';
import { testApprovalRoutes } from './testApproval';
import { cfAccessRedirectLoginRoutes } from './cfAccessRedirectLogin';
import { passkeyRoutes } from './passkeys';

export const authRoutes = new Hono();

// NO global middleware — auth routes have mixed public/authenticated endpoints.
// Each route file applies authMiddleware per-endpoint as needed.

authRoutes.route('/', registerRoutes);
authRoutes.route('/', loginRoutes);
authRoutes.route('/', mfaRoutes);
authRoutes.route('/', passkeyRoutes);
authRoutes.route('/', phoneRoutes);
authRoutes.route('/', passwordRoutes);
authRoutes.route('/', inviteRoutes);
authRoutes.route('/', verifyEmailRoutes);
authRoutes.route('/', accountDeletionRoutes);
authRoutes.route('/', testApprovalRoutes);
authRoutes.route('/', cfAccessRedirectLoginRoutes);
