import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { ASSIGNABLE_PERMISSIONS } from '../services/permissions';

export const permissionsCatalogRoutes = new Hono();

permissionsCatalogRoutes.use('*', authMiddleware);

// Human-friendly labels for resources in the catalog.
// Kept here (not in the permissions registry itself) because the registry is
// security-sensitive and labels are UI presentation only.
const RESOURCE_LABELS: Record<string, string> = {
  backup: 'Backup & Recovery',
  devices: 'Devices',
  scripts: 'Scripts',
  alerts: 'Alerts',
  tickets: 'Tickets',
  users: 'Users',
  organizations: 'Organizations',
  sites: 'Sites',
  automations: 'Automations',
  remote: 'Remote Access',
  audit: 'Audit Logs',
  reports: 'Reports',
  billing: 'Billing'
};

const ACTION_LABELS: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  delete: 'Delete',
  execute: 'Execute',
  acknowledge: 'Acknowledge',
  invite: 'Invite',
  access: 'Access',
  export: 'Export',
  manage: 'Manage'
};

// GET /permissions/catalog - Returns the authoritative list of assignable
// permissions for the role-permission matrix UI. Read-only.
permissionsCatalogRoutes.get('/catalog', async (c) => {
  return c.json({
    permissions: ASSIGNABLE_PERMISSIONS,
    resourceLabels: RESOURCE_LABELS,
    actionLabels: ACTION_LABELS
  });
});
