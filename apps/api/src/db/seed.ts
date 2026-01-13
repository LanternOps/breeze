import { db } from './index';
import { roles, permissions, rolePermissions } from './schema';
import { eq } from 'drizzle-orm';

// Default permissions
const DEFAULT_PERMISSIONS = [
  // Devices
  { resource: 'devices', action: 'read', description: 'View devices and their details' },
  { resource: 'devices', action: 'write', description: 'Create and update devices' },
  { resource: 'devices', action: 'delete', description: 'Delete/decommission devices' },
  { resource: 'devices', action: 'execute', description: 'Execute commands on devices' },

  // Scripts
  { resource: 'scripts', action: 'read', description: 'View scripts' },
  { resource: 'scripts', action: 'write', description: 'Create and edit scripts' },
  { resource: 'scripts', action: 'delete', description: 'Delete scripts' },
  { resource: 'scripts', action: 'execute', description: 'Execute scripts on devices' },

  // Alerts
  { resource: 'alerts', action: 'read', description: 'View alerts' },
  { resource: 'alerts', action: 'write', description: 'Create and edit alert rules' },
  { resource: 'alerts', action: 'acknowledge', description: 'Acknowledge and resolve alerts' },

  // Users
  { resource: 'users', action: 'read', description: 'View users' },
  { resource: 'users', action: 'write', description: 'Edit users' },
  { resource: 'users', action: 'delete', description: 'Remove users' },
  { resource: 'users', action: 'invite', description: 'Invite new users' },

  // Organizations
  { resource: 'organizations', action: 'read', description: 'View organizations' },
  { resource: 'organizations', action: 'write', description: 'Create and edit organizations' },
  { resource: 'organizations', action: 'delete', description: 'Delete organizations' },

  // Sites
  { resource: 'sites', action: 'read', description: 'View sites' },
  { resource: 'sites', action: 'write', description: 'Create and edit sites' },
  { resource: 'sites', action: 'delete', description: 'Delete sites' },

  // Remote access
  { resource: 'remote', action: 'access', description: 'Remote access to devices' },

  // Audit
  { resource: 'audit', action: 'read', description: 'View audit logs' },
  { resource: 'audit', action: 'export', description: 'Export audit logs' },

  // Admin
  { resource: '*', action: '*', description: 'Full administrative access' }
];

// Default system roles
const SYSTEM_ROLES = [
  {
    name: 'Partner Admin',
    scope: 'partner' as const,
    description: 'Full access to partner and all organizations',
    permissions: ['*:*']
  },
  {
    name: 'Partner Technician',
    scope: 'partner' as const,
    description: 'Access to assigned organizations, can execute scripts',
    permissions: [
      'devices:read', 'devices:execute',
      'scripts:read', 'scripts:execute',
      'alerts:read', 'alerts:acknowledge',
      'sites:read',
      'organizations:read'
    ]
  },
  {
    name: 'Partner Viewer',
    scope: 'partner' as const,
    description: 'Read-only access to assigned organizations',
    permissions: [
      'devices:read',
      'scripts:read',
      'alerts:read',
      'sites:read',
      'organizations:read'
    ]
  },
  {
    name: 'Org Admin',
    scope: 'organization' as const,
    description: 'Full access within organization',
    permissions: [
      'devices:read', 'devices:write', 'devices:delete', 'devices:execute',
      'scripts:read', 'scripts:write', 'scripts:delete', 'scripts:execute',
      'alerts:read', 'alerts:write', 'alerts:acknowledge',
      'users:read', 'users:write', 'users:delete', 'users:invite',
      'sites:read', 'sites:write', 'sites:delete',
      'remote:access',
      'audit:read'
    ]
  },
  {
    name: 'Org Technician',
    scope: 'organization' as const,
    description: 'Execute scripts and manage devices',
    permissions: [
      'devices:read', 'devices:write', 'devices:execute',
      'scripts:read', 'scripts:execute',
      'alerts:read', 'alerts:acknowledge',
      'sites:read',
      'remote:access'
    ]
  },
  {
    name: 'Org Viewer',
    scope: 'organization' as const,
    description: 'Read-only access within organization',
    permissions: [
      'devices:read',
      'scripts:read',
      'alerts:read',
      'sites:read'
    ]
  }
];

export async function seedPermissions() {
  console.log('Seeding permissions...');

  for (const perm of DEFAULT_PERMISSIONS) {
    const existing = await db
      .select()
      .from(permissions)
      .where(eq(permissions.resource, perm.resource))
      .limit(1);

    const match = existing.find(e => e.action === perm.action);

    if (!match) {
      await db.insert(permissions).values(perm);
      console.log('  Created permission:', perm.resource + ':' + perm.action);
    }
  }

  console.log('Permissions seeded.');
}

export async function seedRoles() {
  console.log('Seeding system roles...');

  // Get all permissions for lookup
  const allPerms = await db.select().from(permissions);
  const permMap = new Map(allPerms.map(p => [p.resource + ':' + p.action, p.id]));

  for (const roleDef of SYSTEM_ROLES) {
    // Check if role already exists
    const [existing] = await db
      .select()
      .from(roles)
      .where(eq(roles.name, roleDef.name))
      .limit(1);

    let roleId: string;

    if (existing) {
      roleId = existing.id;
      console.log('  Role exists:', roleDef.name);
    } else {
      const [newRole] = await db
        .insert(roles)
        .values({
          name: roleDef.name,
          scope: roleDef.scope,
          description: roleDef.description,
          isSystem: true
        })
        .returning();

      if (!newRole) {
        console.error('  Failed to create role:', roleDef.name);
        continue;
      }
      roleId = newRole.id;
      console.log('  Created role:', roleDef.name);
    }

    // Assign permissions to role
    for (const permKey of roleDef.permissions) {
      const permId = permMap.get(permKey);
      if (permId) {
        try {
          await db.insert(rolePermissions).values({
            roleId,
            permissionId: permId
          });
        } catch {
          // Permission already assigned, ignore
        }
      }
    }
  }

  console.log('Roles seeded.');
}

export async function seed() {
  await seedPermissions();
  await seedRoles();
  console.log('Database seeding complete.');
}

// Run if executed directly
if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
