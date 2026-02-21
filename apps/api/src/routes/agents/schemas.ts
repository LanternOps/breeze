import { z } from 'zod';
import { isIP } from 'node:net';

// ============================================
// Enrollment
// ============================================

export const enrollSchema = z.object({
  enrollmentKey: z.string().min(1),
  enrollmentSecret: z.string().min(1).optional(),
  hostname: z.string().min(1),
  osType: z.enum(['windows', 'macos', 'linux']),
  osVersion: z.string().min(1),
  architecture: z.string().min(1),
  agentVersion: z.string().min(1),
  hardwareInfo: z.object({
    cpuModel: z.string().optional(),
    cpuCores: z.number().int().optional(),
    cpuThreads: z.number().int().optional(),
    ramTotalMb: z.number().int().optional(),
    diskTotalGb: z.number().int().optional(),
    serialNumber: z.string().optional(),
    manufacturer: z.string().optional(),
    model: z.string().optional(),
    biosVersion: z.string().optional(),
    gpuModel: z.string().optional()
  }).optional(),
  networkInfo: z.array(z.object({
    name: z.string(),
    mac: z.string().optional(),
    ip: z.string().optional(),
    isPrimary: z.boolean().optional()
  })).optional()
});

// ============================================
// Heartbeat
// ============================================

export const heartbeatSchema = z.object({
  metrics: z.object({
    cpuPercent: z.number(),
    ramPercent: z.number(),
    ramUsedMb: z.number().int(),
    diskPercent: z.number(),
    diskUsedGb: z.number(),
    networkInBytes: z.number().int().optional(),
    networkOutBytes: z.number().int().optional(),
    bandwidthInBps: z.number().int().min(0).optional(),
    bandwidthOutBps: z.number().int().min(0).optional(),
    interfaceStats: z.array(z.object({
      name: z.string().min(1),
      inBytesPerSec: z.number().int().min(0),
      outBytesPerSec: z.number().int().min(0),
      inBytes: z.number().int().min(0),
      outBytes: z.number().int().min(0),
      inPackets: z.number().int().min(0),
      outPackets: z.number().int().min(0),
      inErrors: z.number().int().min(0),
      outErrors: z.number().int().min(0),
      speed: z.number().int().min(0).optional()
    })).max(100).optional(),
    processCount: z.number().int().optional()
  }),
  status: z.enum(['ok', 'warning', 'error']),
  agentVersion: z.string(),
  ipHistoryUpdate: z.object({
    deviceId: z.string().optional(),
    currentIPs: z.array(z.object({
      interfaceName: z.string().min(1).max(100),
      ipAddress: z.string().trim().max(45).refine(
        (value) => {
          const withoutZone = value.includes('%') ? value.slice(0, Math.max(value.indexOf('%'), 0)) : value;
          return isIP(withoutZone) !== 0;
        },
        { message: 'Invalid IP address format' }
      ),
      ipType: z.enum(['ipv4', 'ipv6']).optional(),
      assignmentType: z.enum(['dhcp', 'static', 'vpn', 'link-local', 'unknown']).optional(),
      macAddress: z.string().max(17).optional(),
      subnetMask: z.string().max(45).optional(),
      gateway: z.string().max(45).optional(),
      dnsServers: z.array(z.string().max(45)).max(8).optional()
    })).max(100).optional(),
    changedIPs: z.array(z.object({
      interfaceName: z.string().min(1).max(100),
      ipAddress: z.string().trim().max(45).refine(
        (value) => {
          const withoutZone = value.includes('%') ? value.slice(0, Math.max(value.indexOf('%'), 0)) : value;
          return isIP(withoutZone) !== 0;
        },
        { message: 'Invalid IP address format' }
      ),
      ipType: z.enum(['ipv4', 'ipv6']).optional(),
      assignmentType: z.enum(['dhcp', 'static', 'vpn', 'link-local', 'unknown']).optional(),
      macAddress: z.string().max(17).optional(),
      subnetMask: z.string().max(45).optional(),
      gateway: z.string().max(45).optional(),
      dnsServers: z.array(z.string().max(45)).max(8).optional()
    })).max(100).optional(),
    removedIPs: z.array(z.object({
      interfaceName: z.string().min(1).max(100),
      ipAddress: z.string().trim().max(45).refine(
        (value) => {
          const withoutZone = value.includes('%') ? value.slice(0, Math.max(value.indexOf('%'), 0)) : value;
          return isIP(withoutZone) !== 0;
        },
        { message: 'Invalid IP address format' }
      ),
      ipType: z.enum(['ipv4', 'ipv6']).optional(),
      assignmentType: z.enum(['dhcp', 'static', 'vpn', 'link-local', 'unknown']).optional(),
      macAddress: z.string().max(17).optional(),
      subnetMask: z.string().max(45).optional(),
      gateway: z.string().max(45).optional(),
      dnsServers: z.array(z.string().max(45)).max(8).optional()
    })).max(100).optional(),
    detectedAt: z.string().datetime({ offset: true }).optional()
  }).optional(),
  pendingReboot: z.boolean().optional(),
  lastUser: z.string().max(255).optional(),
  uptime: z.number().int().min(0).optional()
});

// ============================================
// Commands
// ============================================

export const commandResultSchema = z.object({
  status: z.enum(['completed', 'failed', 'timeout']),
  exitCode: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  durationMs: z.number().int(),
  error: z.string().optional()
});

// ============================================
// Security
// ============================================

export const securityProviderValues = [
  'windows_defender',
  'bitdefender',
  'sophos',
  'sentinelone',
  'crowdstrike',
  'malwarebytes',
  'eset',
  'kaspersky',
  'other'
] as const;

export type SecurityProviderValue = (typeof securityProviderValues)[number];

export const securityStatusIngestSchema = z.object({
  provider: z.string().optional(),
  providerVersion: z.string().optional(),
  definitionsVersion: z.string().optional(),
  definitionsDate: z.string().optional(),
  lastScan: z.string().optional(),
  lastScanType: z.string().optional(),
  realTimeProtection: z.boolean().optional(),
  threatCount: z.number().int().min(0).optional(),
  firewallEnabled: z.boolean().optional(),
  encryptionStatus: z.string().optional(),
  encryptionDetails: z.record(z.unknown()).optional(),
  localAdminSummary: z.record(z.unknown()).optional(),
  passwordPolicySummary: z.record(z.unknown()).optional(),
  gatekeeperEnabled: z.boolean().optional(),
  guardianEnabled: z.boolean().optional(),
  windowsSecurityCenterAvailable: z.boolean().optional(),
  avProducts: z.array(
    z.object({
      displayName: z.string().optional(),
      provider: z.string().optional(),
      realTimeProtection: z.boolean().optional(),
      definitionsUpToDate: z.boolean().optional(),
      productState: z.number().int().optional()
    }).passthrough()
  ).optional()
}).passthrough();

export type SecurityStatusPayload = z.infer<typeof securityStatusIngestSchema>;

export const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const securityCommandTypes = {
  collectStatus: 'security_collect_status',
  scan: 'security_scan',
  quarantine: 'security_threat_quarantine',
  remove: 'security_threat_remove',
  restore: 'security_threat_restore'
} as const;

export const filesystemAnalysisCommandType = 'filesystem_analysis';

// ============================================
// Management Posture
// ============================================

export const managementPostureIngestSchema = z.object({
  collectedAt: z.string().datetime(),
  scanDurationMs: z.number().int().nonnegative(),
  categories: z.record(
    z.enum(['mdm', 'rmm', 'remoteAccess', 'endpointSecurity',
            'policyEngine', 'backup', 'identityMfa', 'siem',
            'dnsFiltering', 'zeroTrustVpn', 'patchManagement']),
    z.array(z.object({
      name: z.string(),
      version: z.string().optional(),
      status: z.enum(['active', 'installed', 'unknown']),
      serviceName: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    }))
  ),
  identity: z.object({
    joinType: z.enum(['hybrid_azure_ad', 'azure_ad', 'on_prem_ad', 'workplace', 'none']),
    azureAdJoined: z.boolean(),
    domainJoined: z.boolean(),
    workplaceJoined: z.boolean(),
    domainName: z.string().optional(),
    tenantId: z.string().optional(),
    mdmUrl: z.string().optional(),
    source: z.string(),
  }),
  errors: z.array(z.string()).optional(),
});

// ============================================
// Inventory
// ============================================

export const updateHardwareSchema = z.object({
  cpuModel: z.string().optional(),
  cpuCores: z.number().int().optional(),
  cpuThreads: z.number().int().optional(),
  ramTotalMb: z.number().int().optional(),
  diskTotalGb: z.number().int().optional(),
  serialNumber: z.string().optional(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  biosVersion: z.string().optional(),
  gpuModel: z.string().optional()
});

export const updateSoftwareSchema = z.object({
  software: z.array(z.object({
    name: z.string().min(1),
    version: z.string().optional(),
    vendor: z.string().optional(),
    installDate: z.string().optional(),
    installLocation: z.string().optional(),
    uninstallString: z.string().optional()
  }))
});

export const updateDisksSchema = z.object({
  disks: z.array(z.object({
    mountPoint: z.string().min(1),
    device: z.string().optional(),
    fsType: z.string().optional(),
    totalGb: z.number(),
    usedGb: z.number(),
    freeGb: z.number(),
    usedPercent: z.number(),
    health: z.string().optional()
  }))
});

export const updateNetworkSchema = z.object({
  adapters: z.array(z.object({
    interfaceName: z.string().min(1),
    macAddress: z.string().optional(),
    ipAddress: z.string().optional(),
    ipType: z.enum(['ipv4', 'ipv6']).optional(),
    isPrimary: z.boolean().optional()
  }))
});

// ============================================
// State
// ============================================

export const updateRegistryStateSchema = z.object({
  entries: z.array(z.object({
    registryPath: z.string().min(1),
    valueName: z.string().min(1),
    valueData: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    valueType: z.string().optional(),
    collectedAt: z.string().optional()
  })),
  replace: z.boolean().optional().default(true)
});

export const updateConfigStateSchema = z.object({
  entries: z.array(z.object({
    filePath: z.string().min(1),
    configKey: z.string().min(1),
    configValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    collectedAt: z.string().optional()
  })),
  replace: z.boolean().optional().default(true)
});

// ============================================
// Sessions
// ============================================

const sessionTypeSchema = z.enum(['console', 'rdp', 'ssh', 'other']);
const sessionActivityStateSchema = z.enum(['active', 'idle', 'locked', 'away', 'disconnected']);
const sessionEventTypeSchema = z.enum(['login', 'logout', 'lock', 'unlock', 'switch']);

export const submitSessionsSchema = z.object({
  sessions: z.array(z.object({
    username: z.string().min(1).max(255),
    sessionType: sessionTypeSchema,
    sessionId: z.string().max(128).optional(),
    loginAt: z.string().optional(),
    idleMinutes: z.number().int().min(0).max(10080).optional(),
    activityState: sessionActivityStateSchema.optional(),
    loginPerformanceSeconds: z.number().int().min(0).max(36000).optional(),
    isActive: z.boolean().optional(),
    lastActivityAt: z.string().optional(),
  })).max(128).default([]),
  events: z.array(z.object({
    type: sessionEventTypeSchema,
    username: z.string().min(1).max(255),
    sessionType: sessionTypeSchema,
    sessionId: z.string().max(128).optional(),
    timestamp: z.string().optional(),
    activityState: sessionActivityStateSchema.optional(),
  })).max(256).nullish(),
  collectedAt: z.string().optional(),
});

// ============================================
// Patches
// ============================================

export const submitPatchesSchema = z.object({
  patches: z.array(z.object({
    name: z.string().min(1),
    version: z.string().optional(),
    currentVersion: z.string().optional(),
    kbNumber: z.string().optional(),
    externalId: z.string().optional(),
    category: z.string().optional(),
    severity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional(),
    size: z.number().int().optional(),
    requiresRestart: z.boolean().optional(),
    releaseDate: z.string().optional(),
    description: z.string().optional(),
    source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).default('custom')
  })),
  installed: z.array(z.object({
    name: z.string().min(1),
    version: z.string().optional(),
    kbNumber: z.string().optional(),
    externalId: z.string().optional(),
    category: z.string().optional(),
    source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).default('custom'),
    installedAt: z.string().optional()
  })).optional()
});

// ============================================
// Connections
// ============================================

export const submitConnectionsSchema = z.object({
  connections: z.array(z.object({
    protocol: z.enum(['tcp', 'tcp6', 'udp', 'udp6']),
    localAddr: z.string().min(1),
    localPort: z.number().int().min(0).max(65535),
    remoteAddr: z.string().optional(),
    remotePort: z.number().int().min(0).max(65535).optional(),
    state: z.string().optional(),
    pid: z.number().int().optional(),
    processName: z.string().optional()
  }))
});

// ============================================
// Agent Diagnostic Logs
// ============================================

export const agentLogEntrySchema = z.object({
  timestamp: z.string().datetime(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  component: z.string().max(100),
  message: z.string(),
  fields: z.record(z.any()).optional(),
  agentVersion: z.string().max(50).optional(),
});

export const agentLogIngestSchema = z.object({
  logs: z.array(agentLogEntrySchema).max(500),
});

// ============================================
// Event Logs
// ============================================

export const submitEventLogsSchema = z.object({
  events: z.array(z.object({
    timestamp: z.string().min(1),
    level: z.enum(['info', 'warning', 'error', 'critical']),
    category: z.enum(['security', 'hardware', 'application', 'system']),
    source: z.string().min(1),
    eventId: z.string().optional(),
    message: z.string().min(1),
    details: z.record(z.any()).optional()
  }))
});

// ============================================
// Download
// ============================================

export const VALID_OS = new Set(['linux', 'darwin', 'windows']);
export const VALID_ARCH = new Set(['amd64', 'arm64']);

// ============================================
// Policy Probe Types
// ============================================

export type PolicyRegistryProbeUpdate = {
  registry_path: string;
  value_name: string;
};

export type PolicyConfigProbeUpdate = {
  file_path: string;
  config_key: string;
};

export type PolicyProbeConfigUpdate = {
  policy_registry_state_probes: PolicyRegistryProbeUpdate[];
  policy_config_state_probes: PolicyConfigProbeUpdate[];
};

// ============================================
// Filesystem Threshold Constants
// ============================================

export function parseEnvBoundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

export const filesystemDiskThresholdPercent = parseEnvBoundedNumber(
  process.env.FILESYSTEM_ANALYSIS_DISK_THRESHOLD,
  85,
  50,
  100
);
export const filesystemThresholdCooldownMinutes = parseEnvBoundedNumber(
  process.env.FILESYSTEM_ANALYSIS_THRESHOLD_COOLDOWN_MINUTES,
  120,
  5,
  1440
);
export const filesystemAutoResumeMaxRuns = parseEnvBoundedNumber(
  process.env.FILESYSTEM_ANALYSIS_AUTO_RESUME_MAX_RUNS,
  200,
  1,
  5000
);
