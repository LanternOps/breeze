import { db } from './index';
import { roles, permissions, rolePermissions, scripts, alertTemplates } from './schema';
import { eq, and } from 'drizzle-orm';

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

// System scripts for RMM operations - only action scripts, not info gathering (agent has native collectors)
const SYSTEM_SCRIPTS = [
  // === WINDOWS SCRIPTS ===
  {
    name: 'IP Configuration',
    description: 'Displays IP configuration for all network adapters',
    category: 'Network',
    osTypes: ['windows'],
    language: 'cmd' as const,
    content: `ipconfig /all`,
    timeoutSeconds: 30,
    runAs: 'system' as const
  },
  {
    name: 'Flush DNS Cache',
    description: 'Clears the DNS resolver cache',
    category: 'Network',
    osTypes: ['windows'],
    language: 'cmd' as const,
    content: `ipconfig /flushdns`,
    timeoutSeconds: 30,
    runAs: 'elevated' as const
  },
  {
    name: 'Clear Print Queue',
    description: 'Stops the print spooler, clears the queue, and restarts it',
    category: 'Troubleshooting',
    osTypes: ['windows'],
    language: 'cmd' as const,
    content: `net stop spooler
del /Q /F /S "%systemroot%\\System32\\spool\\PRINTERS\\*.*"
net start spooler
echo Print queue cleared successfully`,
    timeoutSeconds: 60,
    runAs: 'elevated' as const
  },
  {
    name: 'Clear Windows Temp Files',
    description: 'Cleans temporary files and caches on Windows',
    category: 'Maintenance',
    osTypes: ['windows'],
    language: 'powershell' as const,
    content: `# Clear Windows Temp Files
Write-Host "Clearing temporary files..." -ForegroundColor Cyan

# User temp
\$userTemp = [System.IO.Path]::GetTempPath()
Get-ChildItem \$userTemp -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
Write-Host "Cleared user temp folder"

# Windows temp
Get-ChildItem "C:\\Windows\\Temp" -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
Write-Host "Cleared Windows temp folder"

# Prefetch
Get-ChildItem "C:\\Windows\\Prefetch" -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Host "Cleared prefetch folder"

Write-Host ""
Write-Host "Cleanup complete!" -ForegroundColor Green
`,
    timeoutSeconds: 120,
    runAs: 'elevated' as const
  },
  {
    name: 'Restart Windows Explorer',
    description: 'Restarts Windows Explorer to resolve shell issues',
    category: 'Troubleshooting',
    osTypes: ['windows'],
    language: 'cmd' as const,
    content: `taskkill /f /im explorer.exe
start explorer.exe
echo Windows Explorer restarted`,
    timeoutSeconds: 30,
    runAs: 'system' as const
  },
  {
    name: 'Release and Renew IP',
    description: 'Releases and renews DHCP IP address',
    category: 'Network',
    osTypes: ['windows'],
    language: 'cmd' as const,
    content: `ipconfig /release
ipconfig /renew
ipconfig`,
    timeoutSeconds: 60,
    runAs: 'elevated' as const
  },

  // === macOS SCRIPTS ===
  {
    name: 'Flush DNS Cache (macOS)',
    description: 'Clears the DNS resolver cache on macOS',
    category: 'Network',
    osTypes: ['macos'],
    language: 'bash' as const,
    content: `#!/bin/bash
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder
echo "DNS cache flushed successfully"`,
    timeoutSeconds: 30,
    runAs: 'elevated' as const
  },
  {
    name: 'Clear System Cache',
    description: 'Clears system caches to free up disk space on macOS',
    category: 'Maintenance',
    osTypes: ['macos'],
    language: 'bash' as const,
    content: `#!/bin/bash
echo "Clearing system caches..."

# User caches
rm -rf ~/Library/Caches/* 2>/dev/null
echo "Cleared user caches"

# Font caches
sudo atsutil databases -remove 2>/dev/null
echo "Cleared font caches"

echo "Cache clearing complete!"`,
    timeoutSeconds: 120,
    runAs: 'elevated' as const
  },
  {
    name: 'Restart Finder',
    description: 'Restarts the Finder application to resolve UI issues',
    category: 'Troubleshooting',
    osTypes: ['macos'],
    language: 'bash' as const,
    content: `#!/bin/bash
killall Finder
echo "Finder restarted successfully"`,
    timeoutSeconds: 30,
    runAs: 'user' as const
  },
  {
    name: 'Restart Dock',
    description: 'Restarts the Dock to resolve UI issues',
    category: 'Troubleshooting',
    osTypes: ['macos'],
    language: 'bash' as const,
    content: `#!/bin/bash
killall Dock
echo "Dock restarted successfully"`,
    timeoutSeconds: 30,
    runAs: 'user' as const
  },
  {
    name: 'Clear Print Queue (macOS)',
    description: 'Clears all pending print jobs on macOS',
    category: 'Troubleshooting',
    osTypes: ['macos'],
    language: 'bash' as const,
    content: `#!/bin/bash
cancel -a -
echo "Print queue cleared successfully"`,
    timeoutSeconds: 30,
    runAs: 'elevated' as const
  },
  {
    name: 'Network Configuration (macOS)',
    description: 'Displays network interface configuration',
    category: 'Network',
    osTypes: ['macos'],
    language: 'bash' as const,
    content: `#!/bin/bash
echo "=== Network Interfaces ==="
ifconfig | grep -E "^[a-z]|inet "
echo ""
echo "=== Default Gateway ==="
netstat -rn | grep default`,
    timeoutSeconds: 30,
    runAs: 'system' as const
  },
  {
    name: 'Renew DHCP Lease',
    description: 'Renews the DHCP lease on the primary interface',
    category: 'Network',
    osTypes: ['macos'],
    language: 'bash' as const,
    content: `#!/bin/bash
sudo ipconfig set en0 DHCP
echo "DHCP lease renewed on en0"`,
    timeoutSeconds: 30,
    runAs: 'elevated' as const
  },

  // === LINUX SCRIPTS ===
  {
    name: 'Flush DNS Cache (Linux)',
    description: 'Clears the DNS resolver cache on Linux',
    category: 'Network',
    osTypes: ['linux'],
    language: 'bash' as const,
    content: `#!/bin/bash
if command -v systemd-resolve &> /dev/null; then
    sudo systemd-resolve --flush-caches
    echo "DNS cache flushed (systemd-resolved)"
elif command -v resolvectl &> /dev/null; then
    sudo resolvectl flush-caches
    echo "DNS cache flushed (resolvectl)"
else
    sudo systemctl restart nscd 2>/dev/null || echo "No DNS cache service found"
fi`,
    timeoutSeconds: 30,
    runAs: 'elevated' as const
  },
  {
    name: 'Network Configuration (Linux)',
    description: 'Displays network interface configuration',
    category: 'Network',
    osTypes: ['linux'],
    language: 'bash' as const,
    content: `#!/bin/bash
echo "=== Network Interfaces ==="
ip addr show
echo ""
echo "=== Default Gateway ==="
ip route | grep default`,
    timeoutSeconds: 30,
    runAs: 'system' as const
  },
  {
    name: 'Clear Print Queue (Linux)',
    description: 'Clears all pending print jobs on Linux',
    category: 'Troubleshooting',
    osTypes: ['linux'],
    language: 'bash' as const,
    content: `#!/bin/bash
cancel -a -
echo "Print queue cleared successfully"`,
    timeoutSeconds: 30,
    runAs: 'elevated' as const
  },
  {
    name: 'Clear Package Cache',
    description: 'Clears package manager cache to free disk space',
    category: 'Maintenance',
    osTypes: ['linux'],
    language: 'bash' as const,
    content: `#!/bin/bash
if command -v apt &> /dev/null; then
    sudo apt clean
    echo "APT cache cleared"
elif command -v dnf &> /dev/null; then
    sudo dnf clean all
    echo "DNF cache cleared"
elif command -v yum &> /dev/null; then
    sudo yum clean all
    echo "YUM cache cleared"
else
    echo "Unknown package manager"
fi`,
    timeoutSeconds: 60,
    runAs: 'elevated' as const
  }
];

export async function seedScripts() {
  console.log('Seeding system scripts...');

  for (const scriptDef of SYSTEM_SCRIPTS) {
    // Check if script already exists by name and isSystem
    const [existing] = await db
      .select()
      .from(scripts)
      .where(
        and(
          eq(scripts.name, scriptDef.name),
          eq(scripts.isSystem, true)
        )
      )
      .limit(1);

    if (existing) {
      console.log('  Script exists:', scriptDef.name);
      continue;
    }

    await db.insert(scripts).values({
      name: scriptDef.name,
      description: scriptDef.description,
      category: scriptDef.category,
      osTypes: scriptDef.osTypes,
      language: scriptDef.language,
      content: scriptDef.content,
      timeoutSeconds: scriptDef.timeoutSeconds,
      runAs: scriptDef.runAs,
      isSystem: true,
      orgId: null // System scripts have no org
    });
    console.log('  Created script:', scriptDef.name);
  }

  console.log('Scripts seeded.');
}

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

// Built-in alert templates for event log conditions
const EVENT_LOG_ALERT_TEMPLATES = [
  {
    name: 'Auth Failure Burst',
    description: '5+ authentication failures within 10 minutes',
    conditions: {
      type: 'event_log',
      category: 'security',
      level: 'error',
      messagePattern: 'authentication',
      countThreshold: 5,
      windowMinutes: 10
    },
    severity: 'high' as const,
    titleTemplate: 'Authentication Failure Burst on {{hostname}}',
    messageTemplate: '{{count}} authentication failures detected on {{hostname}} within 10 minutes',
    cooldownMinutes: 30
  },
  {
    name: 'Application Crash',
    description: 'Application crash detected via crash report',
    conditions: {
      type: 'event_log',
      category: 'application',
      level: 'error',
      countThreshold: 1,
      windowMinutes: 5
    },
    severity: 'medium' as const,
    titleTemplate: 'Application Crash on {{hostname}}',
    messageTemplate: 'Application crash detected on {{hostname}}: {{message}}',
    cooldownMinutes: 15
  },
  {
    name: 'Kernel Panic',
    description: 'Kernel panic or critical system failure detected',
    conditions: {
      type: 'event_log',
      category: 'hardware',
      level: 'critical',
      messagePattern: 'kernel panic',
      countThreshold: 1,
      windowMinutes: 60
    },
    severity: 'critical' as const,
    titleTemplate: 'Kernel Panic on {{hostname}}',
    messageTemplate: 'Critical kernel panic detected on {{hostname}}',
    cooldownMinutes: 60
  },
  {
    name: 'Disk Error Cluster',
    description: '3+ disk/hardware errors within 30 minutes',
    conditions: {
      type: 'event_log',
      category: 'hardware',
      level: 'error',
      countThreshold: 3,
      windowMinutes: 30
    },
    severity: 'high' as const,
    titleTemplate: 'Disk Errors on {{hostname}}',
    messageTemplate: '{{count}} hardware/disk errors detected on {{hostname}} within 30 minutes',
    cooldownMinutes: 60
  },
  {
    name: 'Unexpected Shutdown',
    description: 'Unexpected system shutdown or power loss detected',
    conditions: {
      type: 'event_log',
      category: 'system',
      level: 'warning',
      messagePattern: 'shutdown',
      countThreshold: 1,
      windowMinutes: 60
    },
    severity: 'medium' as const,
    titleTemplate: 'Unexpected Shutdown on {{hostname}}',
    messageTemplate: 'Unexpected system shutdown detected on {{hostname}}',
    cooldownMinutes: 60
  }
];

export async function seedEventLogAlertTemplates() {
  console.log('Seeding event log alert templates...');

  for (const tmpl of EVENT_LOG_ALERT_TEMPLATES) {
    const [existing] = await db
      .select()
      .from(alertTemplates)
      .where(
        and(
          eq(alertTemplates.name, tmpl.name),
          eq(alertTemplates.isBuiltIn, true)
        )
      )
      .limit(1);

    if (existing) {
      console.log('  Template exists:', tmpl.name);
      continue;
    }

    await db.insert(alertTemplates).values({
      name: tmpl.name,
      description: tmpl.description,
      conditions: tmpl.conditions,
      severity: tmpl.severity,
      titleTemplate: tmpl.titleTemplate,
      messageTemplate: tmpl.messageTemplate,
      cooldownMinutes: tmpl.cooldownMinutes,
      isBuiltIn: true,
      orgId: null
    });
    console.log('  Created template:', tmpl.name);
  }

  console.log('Event log alert templates seeded.');
}

export async function seed() {
  await seedPermissions();
  await seedRoles();
  await seedScripts();
  await seedEventLogAlertTemplates();
  console.log('Database seeding complete.');
}

// Run if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
