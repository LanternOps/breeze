import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { authMiddleware } from '../middleware/auth';

export const systemRoutes = new Hono();

systemRoutes.use('*', authMiddleware);

// GET /system/config-status — read-only view of env-driven feature status (no secrets)
systemRoutes.get('/config-status', async (c) => {
  const auth = c.get('auth');
  if (auth.scope !== 'partner') {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const env = process.env;

  // Email provider detection
  let emailProvider: 'resend' | 'smtp' | 'mailgun' | 'none' = 'none';
  const emailConfigured =
    !!env.RESEND_API_KEY || !!env.SMTP_HOST || !!env.MAILGUN_API_KEY;
  if (env.EMAIL_PROVIDER === 'resend' || (!env.EMAIL_PROVIDER && env.RESEND_API_KEY)) {
    emailProvider = 'resend';
  } else if (env.EMAIL_PROVIDER === 'smtp' || (!env.EMAIL_PROVIDER && env.SMTP_HOST)) {
    emailProvider = 'smtp';
  } else if (env.EMAIL_PROVIDER === 'mailgun' || (!env.EMAIL_PROVIDER && env.MAILGUN_API_KEY)) {
    emailProvider = 'mailgun';
  }

  return c.json({
    email: {
      configured: emailConfigured,
      provider: emailProvider,
      from: env.EMAIL_FROM || env.RESEND_FROM || ''
    },
    domain: {
      breezeDomain: env.BREEZE_DOMAIN || '',
      publicUrl: env.PUBLIC_APP_URL || env.DASHBOARD_URL || '',
      corsOrigins: env.CORS_ALLOWED_ORIGINS || ''
    },
    security: {
      httpsForced: env.FORCE_HTTPS === 'true' || env.NODE_ENV === 'production',
      mfaEnabled: env.ENABLE_2FA !== 'false',
      registrationEnabled: env.ENABLE_REGISTRATION !== 'false'
    },
    integrations: {
      sms: !!env.TWILIO_ACCOUNT_SID,
      ai: !!env.ANTHROPIC_API_KEY || !!env.OPENAI_API_KEY,
      mtls: !!env.CLOUDFLARE_API_TOKEN && !!env.CLOUDFLARE_ZONE_ID,
      storage: !!env.S3_BUCKET || !!env.STORAGE_PROVIDER,
      sentry: !!env.SENTRY_DSN
    }
  });
});

// POST /system/setup-complete — marks the current user's setup as complete
systemRoutes.post('/setup-complete', async (c) => {
  const auth = c.get('auth');

  try {
    await db
      .update(users)
      .set({ setupCompletedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, auth.user.id));

    return c.json({ success: true });
  } catch (error) {
    console.error('[system] Failed to mark setup complete:', error);
    return c.json({ error: 'Failed to complete setup' }, 500);
  }
});
