import { coreRequest } from './api';

/** `/auth/me` has identity only; `/users/me` supplies effective RBAC grants. */
export async function getTimeEntryBillingPermission(): Promise<boolean> {
  const profile = await coreRequest<{ isPlatformAdmin?: boolean; permissions?: Array<{ resource: string; action: string }> }>('/users/me');
  // Native authentication is a human user session; mirror the API helper.
  if (profile.isPlatformAdmin === true) return true;
  return profile.permissions?.some(grant =>
    (grant.resource === 'time_entries' || grant.resource === '*') &&
    (grant.action === 'manage_billing' || grant.action === '*')
  ) ?? false;
}
