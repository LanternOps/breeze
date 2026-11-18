/**
 * Static copy for the tenant-setup result page (`/entra-setup?status=...`).
 *
 * The API callback redirects an IT admin's browser here after the Microsoft
 * admin-consent / tenant-proof round trip. The page is public (the admin is not
 * a portal user), so the query string is untrusted: only the four known
 * statuses select copy, anything else is the generic failure.
 */

export type EntraSetupStatus = 'proven' | 'consent_done' | 'invalid' | 'failed';

export const ENTRA_SETUP_COPY: Record<EntraSetupStatus, { title: string; body: string }> = {
  proven: {
    title: 'Tenant verified',
    body: 'Your Microsoft tenant is verified. Next, grant consent for the Breeze portal app.'
  },
  consent_done: {
    title: 'All set',
    body: "All set. Your organization's people can now sign in to the portal with Microsoft once your IT provider turns it on."
  },
  invalid: {
    title: 'Link not valid',
    body: 'This link is invalid or has expired. Ask your IT provider for a new one.'
  },
  failed: {
    title: "We couldn't verify this tenant",
    body: "We couldn't verify this tenant. Make sure you sign in as a Global Administrator or Privileged Role Administrator of the tenant, then ask your IT provider for a new link if this one no longer works."
  }
};

export function resolveEntraSetupStatus(raw: string | null | undefined): EntraSetupStatus {
  if (raw && Object.prototype.hasOwnProperty.call(ENTRA_SETUP_COPY, raw)) {
    return raw as EntraSetupStatus;
  }
  return 'failed';
}
