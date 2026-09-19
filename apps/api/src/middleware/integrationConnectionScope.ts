import type { Context, Next } from 'hono';
import type { AuthContext } from './auth';

/**
 * PSA/DNS connection management affects the entire owning organization, not
 * one site. Organization write permission and MFA do not lift a site ceiling.
 * Keep this before request validation and resource/provider access; ownership,
 * permission, MFA and partner-wide checks remain separate prerequisites.
 */
export async function requireOrgWideIntegrationAccess(c: Context, next: Next) {
  const auth = c.get('auth') as AuthContext | undefined;
  // An empty allowlist is restricted too. Legitimate partner/system contexts
  // have no site ceiling; do not reinterpret a defined ceiling as unrestricted.
  if (!auth || auth.allowedSiteIds !== undefined) {
    return c.json({ error: 'Integration connection management requires unrestricted site access' }, 403);
  }
  await next();
}
