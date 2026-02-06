import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { devices, organizations, auditLogs } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { executeCommand, CommandTypes } from '../services/commandQueue';

export const systemToolsRoutes = new Hono();

// ============================================
// TYPES
// ============================================

interface ProcessInfo {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryMB: number;
  user: string;
  status: 'running' | 'sleeping' | 'stopped' | 'zombie';
  startTime: string;
  commandLine: string;
  parentPid: number | null;
  threads: number;
}

interface ServiceInfo {
  name: string;
  displayName: string;
  status: 'running' | 'stopped' | 'paused' | 'starting' | 'stopping';
  startType: 'auto' | 'manual' | 'disabled' | 'auto_delayed';
  account: string;
  description: string;
  path: string;
  dependencies: string[];
}

interface RegistryKey {
  name: string;
  path: string;
  subKeyCount: number;
  valueCount: number;
  lastModified: string;
}

interface RegistryValue {
  name: string;
  type: 'REG_SZ' | 'REG_EXPAND_SZ' | 'REG_BINARY' | 'REG_DWORD' | 'REG_QWORD' | 'REG_MULTI_SZ';
  data: string | number | string[];
}

interface EventLogInfo {
  name: string;
  displayName: string;
  recordCount: number;
  maxSize: number;
  retentionDays: number;
  lastWriteTime: string;
}

interface EventLogEntry {
  recordId: number;
  timeCreated: string;
  level: 'information' | 'warning' | 'error' | 'critical' | 'verbose';
  source: string;
  eventId: number;
  message: string;
  category: string;
  user: string | null;
  computer: string;
}

interface ScheduledTaskInfo {
  path: string;
  name: string;
  state: 'ready' | 'running' | 'disabled' | 'queued';
  lastRunTime: string | null;
  lastRunResult: number | null;
  nextRunTime: string | null;
  author: string;
  description: string;
  triggers: Array<{
    type: string;
    enabled: boolean;
    schedule?: string;
  }>;
  actions: Array<{
    type: string;
    path?: string;
    arguments?: string;
  }>;
}

interface FileEntryInfo {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
  permissions?: string;
}

type RegistryOverrides = {
  added: Set<string>;
  removed: Set<string>;
};

// ============================================
// HELPER FUNCTIONS
// ============================================

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(orgId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, orgId),
          eq(organizations.partnerId, auth.partnerId as string)
        )
      )
      .limit(1);

    return Boolean(org);
  }

  // system scope has access to all
  return true;
}

async function getDeviceWithOrgCheck(deviceId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(device.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return device;
}

async function createAuditLog(params: {
  orgId: string;
  actorId: string;
  actorEmail: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  resourceName?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  result: 'success' | 'failure' | 'denied';
  errorMessage?: string;
}) {
  await db.insert(auditLogs).values({
    orgId: params.orgId,
    actorType: 'user',
    actorId: params.actorId,
    actorEmail: params.actorEmail,
    action: params.action,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    resourceName: params.resourceName,
    details: params.details,
    ipAddress: params.ipAddress,
    result: params.result,
    errorMessage: params.errorMessage
  });
}

// Mock data generators for development
function generateMockProcesses(): ProcessInfo[] {
  return [
    { pid: 1, name: 'System Idle Process', cpuPercent: 0, memoryMB: 0, user: 'SYSTEM', status: 'running', startTime: '2024-01-01T00:00:00Z', commandLine: '', parentPid: null, threads: 8 },
    { pid: 4, name: 'System', cpuPercent: 0.1, memoryMB: 2.4, user: 'SYSTEM', status: 'running', startTime: '2024-01-01T00:00:00Z', commandLine: '', parentPid: 0, threads: 156 },
    { pid: 624, name: 'services.exe', cpuPercent: 0.2, memoryMB: 12.8, user: 'SYSTEM', status: 'running', startTime: '2024-01-01T00:00:01Z', commandLine: 'C:\\Windows\\system32\\services.exe', parentPid: 512, threads: 14 },
    { pid: 712, name: 'lsass.exe', cpuPercent: 0.1, memoryMB: 18.2, user: 'SYSTEM', status: 'running', startTime: '2024-01-01T00:00:01Z', commandLine: 'C:\\Windows\\system32\\lsass.exe', parentPid: 512, threads: 12 },
    { pid: 1024, name: 'svchost.exe', cpuPercent: 1.5, memoryMB: 45.6, user: 'NETWORK SERVICE', status: 'running', startTime: '2024-01-01T00:00:02Z', commandLine: 'C:\\Windows\\system32\\svchost.exe -k netsvcs', parentPid: 624, threads: 28 },
    { pid: 2048, name: 'explorer.exe', cpuPercent: 2.3, memoryMB: 128.4, user: 'CONTOSO\\admin', status: 'running', startTime: '2024-01-01T08:30:00Z', commandLine: 'C:\\Windows\\explorer.exe', parentPid: 3456, threads: 45 },
    { pid: 3456, name: 'chrome.exe', cpuPercent: 8.5, memoryMB: 512.3, user: 'CONTOSO\\admin', status: 'running', startTime: '2024-01-01T09:00:00Z', commandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"', parentPid: 2048, threads: 62 },
    { pid: 4567, name: 'notepad.exe', cpuPercent: 0, memoryMB: 8.2, user: 'CONTOSO\\admin', status: 'running', startTime: '2024-01-01T10:15:00Z', commandLine: 'C:\\Windows\\system32\\notepad.exe', parentPid: 2048, threads: 4 }
  ];
}

function generateMockServices(): ServiceInfo[] {
  return [
    { name: 'wuauserv', displayName: 'Windows Update', status: 'running', startType: 'auto_delayed', account: 'LocalSystem', description: 'Enables the detection, download, and installation of updates for Windows and other programs.', path: 'C:\\Windows\\system32\\svchost.exe -k netsvcs', dependencies: ['rpcss'] },
    { name: 'Spooler', displayName: 'Print Spooler', status: 'running', startType: 'auto', account: 'LocalSystem', description: 'Loads files to memory for later printing.', path: 'C:\\Windows\\System32\\spoolsv.exe', dependencies: ['RPCSS', 'http'] },
    { name: 'BITS', displayName: 'Background Intelligent Transfer Service', status: 'running', startType: 'auto_delayed', account: 'LocalSystem', description: 'Transfers files in the background using idle network bandwidth.', path: 'C:\\Windows\\System32\\svchost.exe -k netsvcs', dependencies: ['RpcSs'] },
    { name: 'WinRM', displayName: 'Windows Remote Management (WS-Management)', status: 'stopped', startType: 'manual', account: 'NT AUTHORITY\\NetworkService', description: 'Windows Remote Management service implements the WS-Management protocol.', path: 'C:\\Windows\\System32\\svchost.exe -k NetworkService', dependencies: ['RPCSS', 'HTTP'] },
    { name: 'RemoteRegistry', displayName: 'Remote Registry', status: 'stopped', startType: 'disabled', account: 'NT AUTHORITY\\LocalService', description: 'Enables remote users to modify registry settings on this computer.', path: 'C:\\Windows\\system32\\svchost.exe -k regsvc', dependencies: ['RpcSs'] },
    { name: 'Dnscache', displayName: 'DNS Client', status: 'running', startType: 'auto', account: 'NT AUTHORITY\\NetworkService', description: 'Caches Domain Name System names and registers the full computer name.', path: 'C:\\Windows\\system32\\svchost.exe -k NetworkService', dependencies: ['nsi', 'Tdx'] }
  ];
}

function generateMockEventLogs(): EventLogInfo[] {
  return [
    { name: 'Application', displayName: 'Application', recordCount: 15234, maxSize: 20971520, retentionDays: 7, lastWriteTime: '2024-01-13T15:30:00Z' },
    { name: 'System', displayName: 'System', recordCount: 28456, maxSize: 20971520, retentionDays: 7, lastWriteTime: '2024-01-13T15:29:45Z' },
    { name: 'Security', displayName: 'Security', recordCount: 45678, maxSize: 134217728, retentionDays: 30, lastWriteTime: '2024-01-13T15:29:50Z' },
    { name: 'Setup', displayName: 'Setup', recordCount: 156, maxSize: 1048576, retentionDays: 7, lastWriteTime: '2024-01-10T10:00:00Z' },
    { name: 'Microsoft-Windows-PowerShell/Operational', displayName: 'PowerShell Operational', recordCount: 8923, maxSize: 15728640, retentionDays: 7, lastWriteTime: '2024-01-13T14:00:00Z' }
  ];
}

function generateMockEventEntries(): EventLogEntry[] {
  return [
    { recordId: 15234, timeCreated: '2024-01-13T15:30:00Z', level: 'information', source: 'Application', eventId: 1000, message: 'Application started successfully.', category: 'None', user: null, computer: 'WORKSTATION-01' },
    { recordId: 15233, timeCreated: '2024-01-13T15:15:00Z', level: 'warning', source: 'Application', eventId: 1001, message: 'Low disk space warning on drive C:.', category: 'None', user: null, computer: 'WORKSTATION-01' },
    { recordId: 15232, timeCreated: '2024-01-13T14:45:00Z', level: 'error', source: 'Application Error', eventId: 1000, message: 'Faulting application name: app.exe, version: 1.0.0.0.', category: 'None', user: null, computer: 'WORKSTATION-01' },
    { recordId: 15231, timeCreated: '2024-01-13T14:30:00Z', level: 'information', source: '.NET Runtime', eventId: 1026, message: '.NET Runtime version 4.8.4515.0 initialized.', category: 'None', user: null, computer: 'WORKSTATION-01' },
    { recordId: 15230, timeCreated: '2024-01-13T14:00:00Z', level: 'critical', source: 'EventLog', eventId: 6008, message: 'The previous system shutdown was unexpected.', category: 'None', user: 'SYSTEM', computer: 'WORKSTATION-01' }
  ];
}

function generateMockScheduledTasks(): ScheduledTaskInfo[] {
  return [
    {
      path: '\\Microsoft\\Windows\\Windows Defender\\Windows Defender Scheduled Scan',
      name: 'Windows Defender Scheduled Scan',
      state: 'ready',
      lastRunTime: '2024-01-13T03:00:00Z',
      lastRunResult: 0,
      nextRunTime: '2024-01-14T03:00:00Z',
      author: 'Microsoft Corporation',
      description: 'Periodic scan task.',
      triggers: [{ type: 'Daily', enabled: true, schedule: '3:00 AM' }],
      actions: [{ type: 'Execute', path: '%ProgramFiles%\\Windows Defender\\MpCmdRun.exe', arguments: '-Scan -ScanType 1' }]
    },
    {
      path: '\\Microsoft\\Windows\\WindowsUpdate\\Scheduled Start',
      name: 'Scheduled Start',
      state: 'ready',
      lastRunTime: '2024-01-13T05:00:00Z',
      lastRunResult: 0,
      nextRunTime: '2024-01-14T05:00:00Z',
      author: 'Microsoft Corporation',
      description: 'This task is used to start the Windows Update service.',
      triggers: [{ type: 'Daily', enabled: true, schedule: '5:00 AM' }],
      actions: [{ type: 'Execute', path: '%systemroot%\\system32\\sc.exe', arguments: 'start wuauserv' }]
    },
    {
      path: '\\Backup\\Daily Backup',
      name: 'Daily Backup',
      state: 'disabled',
      lastRunTime: '2024-01-10T22:00:00Z',
      lastRunResult: 1,
      nextRunTime: null,
      author: 'Admin',
      description: 'Daily backup of critical files.',
      triggers: [{ type: 'Daily', enabled: false, schedule: '10:00 PM' }],
      actions: [{ type: 'Execute', path: 'C:\\Scripts\\backup.ps1' }]
    }
  ];
}

function generateMockFileEntries(path: string): FileEntryInfo[] {
  const normalized = path && path !== '/' ? path.replace(/\/$/, '') : '';
  const joinPath = (name: string) => (normalized ? `${normalized}/${name}` : `/${name}`);
  const now = new Date().toISOString();

  return [
    { name: 'Documents', path: joinPath('Documents'), type: 'directory' },
    { name: 'Downloads', path: joinPath('Downloads'), type: 'directory' },
    { name: 'Pictures', path: joinPath('Pictures'), type: 'directory' },
    { name: 'config.json', path: joinPath('config.json'), type: 'file', size: 2048, modified: now },
    { name: 'readme.md', path: joinPath('readme.md'), type: 'file', size: 5120, modified: now },
    { name: 'app.log', path: joinPath('app.log'), type: 'file', size: 102400, modified: now },
    { name: 'backup.zip', path: joinPath('backup.zip'), type: 'file', size: 52428800, modified: now },
    { name: 'script.py', path: joinPath('script.py'), type: 'file', size: 1536, modified: now }
  ];
}

const registryKeyOverrides = new Map<string, RegistryOverrides>();

function getRegistryOverrides(key: string): RegistryOverrides {
  const existing = registryKeyOverrides.get(key);
  if (existing) return existing;
  const created = { added: new Set<string>(), removed: new Set<string>() };
  registryKeyOverrides.set(key, created);
  return created;
}

// ============================================
// VALIDATION SCHEMAS
// ============================================

const deviceIdParamSchema = z.object({
  deviceId: z.string().uuid()
});

const pidParamSchema = z.object({
  deviceId: z.string().uuid(),
  pid: z.string().transform(val => parseInt(val, 10))
});

const serviceNameParamSchema = z.object({
  deviceId: z.string().uuid(),
  name: z.string().min(1).max(256)
});

const registryQuerySchema = z.object({
  hive: z.enum(['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER', 'HKEY_CLASSES_ROOT', 'HKEY_USERS', 'HKEY_CURRENT_CONFIG']),
  path: z.string().min(0).max(1024)
});

const registryValueQuerySchema = registryQuerySchema.extend({
  name: z.string().min(0).max(256)
});

const registryValueBodySchema = z.object({
  hive: z.enum(['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER', 'HKEY_CLASSES_ROOT', 'HKEY_USERS', 'HKEY_CURRENT_CONFIG']),
  path: z.string().min(0).max(1024),
  name: z.string().min(0).max(256),
  type: z.enum(['REG_SZ', 'REG_EXPAND_SZ', 'REG_BINARY', 'REG_DWORD', 'REG_QWORD', 'REG_MULTI_SZ']),
  data: z.union([z.string(), z.number(), z.array(z.string())])
});

const registryKeyBodySchema = z.object({
  hive: z.enum(['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER', 'HKEY_CLASSES_ROOT', 'HKEY_USERS', 'HKEY_CURRENT_CONFIG']),
  path: z.string().min(1).max(1024)
});

const registryKeyQuerySchema = z.object({
  hive: z.enum(['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER', 'HKEY_CLASSES_ROOT', 'HKEY_USERS', 'HKEY_CURRENT_CONFIG']),
  path: z.string().min(1).max(1024)
});

const eventLogNameParamSchema = z.object({
  deviceId: z.string().uuid(),
  name: z.string().min(1).max(256)
});

const eventLogQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  level: z.enum(['information', 'warning', 'error', 'critical', 'verbose']).optional(),
  source: z.string().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  eventId: z.string().transform(val => parseInt(val, 10)).optional()
});

const eventRecordParamSchema = z.object({
  deviceId: z.string().uuid(),
  name: z.string().min(1).max(256),
  recordId: z.string().transform(val => parseInt(val, 10))
});

const taskPathParamSchema = z.object({
  deviceId: z.string().uuid(),
  path: z.string().min(1).max(512)
});

const fileListQuerySchema = z.object({
  path: z.string().min(1).max(2048)
});

const paginationQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional()
});

// ============================================
// PROCESSES ROUTES
// ============================================

// GET /api/v1/system-tools/devices/:deviceId/processes - List all processes
systemToolsRoutes.get(
  '/devices/:deviceId/processes',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', paginationQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const { page, limit } = getPagination(c.req.valid('query'));
    const search = c.req.query('search') || '';

    // Execute command on agent
    const result = await executeCommand(deviceId, CommandTypes.LIST_PROCESSES, {
      page,
      limit,
      search
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to get processes' }, 500);
    }

    // Parse the result from agent
    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({
        data: data.processes || [],
        meta: {
          total: data.total || 0,
          page: data.page || page,
          limit: data.limit || limit,
          totalPages: data.totalPages || 1
        }
      });
    } catch {
      // Fallback to mock data if agent call fails
      const processes = generateMockProcesses();
      const { offset } = getPagination(c.req.valid('query'));
      const paginatedProcesses = processes.slice(offset, offset + limit);
      return c.json({
        data: paginatedProcesses,
        meta: {
          total: processes.length,
          page,
          limit,
          totalPages: Math.ceil(processes.length / limit)
        }
      });
    }
  }
);

// GET /api/v1/system-tools/devices/:deviceId/processes/:pid - Get process details
systemToolsRoutes.get(
  '/devices/:deviceId/processes/:pid',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', pidParamSchema),
  async (c) => {
    const { deviceId, pid } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    const processes = generateMockProcesses();
    const process = processes.find(p => p.pid === pid);

    if (!process) {
      return c.json({ error: 'Process not found' }, 404);
    }

    return c.json({ data: process });
  }
);

// POST /api/v1/system-tools/devices/:deviceId/processes/:pid/kill - Kill a process
systemToolsRoutes.post(
  '/devices/:deviceId/processes/:pid/kill',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', pidParamSchema),
  async (c) => {
    const { deviceId, pid } = c.req.valid('param');
    const auth = c.get('auth');
    const force = c.req.query('force') === 'true';

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // Execute kill command on agent
    const result = await executeCommand(deviceId, CommandTypes.KILL_PROCESS, {
      pid,
      force
    }, { userId: auth.user?.id, timeoutMs: 15000 });

    // Audit log for sensitive operation
    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'kill_process',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        pid,
        force,
        result: result.status
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: result.status === 'completed' ? 'success' : 'failure',
      errorMessage: result.error
    });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to kill process' }, 500);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({
        success: true,
        message: `Process ${pid} (${data.name || 'unknown'}) terminated successfully`
      });
    } catch {
      return c.json({
        success: true,
        message: `Process ${pid} terminated successfully`
      });
    }
  }
);

// ============================================
// SERVICES ROUTES (Windows)
// ============================================

// GET /api/v1/system-tools/devices/:deviceId/services - List all services
systemToolsRoutes.get(
  '/devices/:deviceId/services',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', paginationQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const { page, limit } = getPagination(c.req.valid('query'));
    const search = c.req.query('search') || '';
    const status = c.req.query('status') || '';

    // Execute command on agent
    const result = await executeCommand(deviceId, CommandTypes.LIST_SERVICES, {
      page,
      limit,
      search,
      status
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to get services' }, 500);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({
        data: data.services || [],
        meta: {
          total: data.total || 0,
          page: data.page || page,
          limit: data.limit || limit,
          totalPages: data.totalPages || 1
        }
      });
    } catch {
      // Fallback to mock data
      const services = generateMockServices();
      const { offset } = getPagination(c.req.valid('query'));
      const paginatedServices = services.slice(offset, offset + limit);
      return c.json({
        data: paginatedServices,
        meta: {
          total: services.length,
          page,
          limit,
          totalPages: Math.ceil(services.length / limit)
        }
      });
    }
  }
);

// GET /api/v1/system-tools/devices/:deviceId/services/:name - Get service details
systemToolsRoutes.get(
  '/devices/:deviceId/services/:name',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', serviceNameParamSchema),
  async (c) => {
    const { deviceId, name } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    const services = generateMockServices();
    const service = services.find(s => s.name === name);

    if (!service) {
      return c.json({ error: 'Service not found' }, 404);
    }

    return c.json({ data: service });
  }
);

// POST /api/v1/system-tools/devices/:deviceId/services/:name/start - Start service
systemToolsRoutes.post(
  '/devices/:deviceId/services/:name/start',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', serviceNameParamSchema),
  async (c) => {
    const { deviceId, name } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const services = generateMockServices();
    const service = services.find(s => s.name === name);

    if (!service) {
      return c.json({ error: 'Service not found' }, 404);
    }

    // Audit log for sensitive operation
    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'start_service',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        serviceName: name,
        serviceDisplayName: service.displayName
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: 'success'
    });

    // TODO: Replace with actual agent call
    return c.json({
      success: true,
      message: `Service ${name} started successfully`,
      data: { ...service, status: 'running' as const }
    });
  }
);

// POST /api/v1/system-tools/devices/:deviceId/services/:name/stop - Stop service
systemToolsRoutes.post(
  '/devices/:deviceId/services/:name/stop',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', serviceNameParamSchema),
  async (c) => {
    const { deviceId, name } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const services = generateMockServices();
    const service = services.find(s => s.name === name);

    if (!service) {
      return c.json({ error: 'Service not found' }, 404);
    }

    // Audit log for sensitive operation
    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'stop_service',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        serviceName: name,
        serviceDisplayName: service.displayName
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: 'success'
    });

    // TODO: Replace with actual agent call
    return c.json({
      success: true,
      message: `Service ${name} stopped successfully`,
      data: { ...service, status: 'stopped' as const }
    });
  }
);

// POST /api/v1/system-tools/devices/:deviceId/services/:name/restart - Restart service
systemToolsRoutes.post(
  '/devices/:deviceId/services/:name/restart',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', serviceNameParamSchema),
  async (c) => {
    const { deviceId, name } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const services = generateMockServices();
    const service = services.find(s => s.name === name);

    if (!service) {
      return c.json({ error: 'Service not found' }, 404);
    }

    // Audit log for sensitive operation
    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'restart_service',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        serviceName: name,
        serviceDisplayName: service.displayName
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: 'success'
    });

    // TODO: Replace with actual agent call
    return c.json({
      success: true,
      message: `Service ${name} restarted successfully`,
      data: { ...service, status: 'running' as const }
    });
  }
);

// ============================================
// REGISTRY ROUTES (Windows)
// ============================================

// GET /api/v1/system-tools/devices/:deviceId/registry/keys - List registry keys
systemToolsRoutes.get(
  '/devices/:deviceId/registry/keys',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', registryQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { hive, path } = c.req.valid('query');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    const prefix = path ? `${path}\\` : '';
    const mockKeys: RegistryKey[] = [
      { name: 'SOFTWARE', path: `${prefix}SOFTWARE`, subKeyCount: 15, valueCount: 0, lastModified: '2024-01-10T10:00:00Z' },
      { name: 'SYSTEM', path: `${prefix}SYSTEM`, subKeyCount: 8, valueCount: 0, lastModified: '2024-01-12T14:30:00Z' },
      { name: 'HARDWARE', path: `${prefix}HARDWARE`, subKeyCount: 3, valueCount: 2, lastModified: '2024-01-01T00:00:00Z' }
    ];

    const overrideKey = `${deviceId}:${hive}:${path}`;
    const overrides = registryKeyOverrides.get(overrideKey);
    const keys = overrides
      ? [
          ...mockKeys.filter(key => !overrides.removed.has(key.name)),
          ...Array.from(overrides.added)
            .filter(name => !mockKeys.some(key => key.name === name))
            .map(name => ({
              name,
              path: `${prefix}${name}`,
              subKeyCount: 0,
              valueCount: 0,
              lastModified: new Date().toISOString()
            }))
        ]
      : mockKeys;

    return c.json({ data: keys });
  }
);

// GET /api/v1/system-tools/devices/:deviceId/registry/values - List registry values
systemToolsRoutes.get(
  '/devices/:deviceId/registry/values',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', registryQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    const mockValues: RegistryValue[] = [
      { name: '(Default)', type: 'REG_SZ', data: '' },
      { name: 'ProductName', type: 'REG_SZ', data: 'Windows 11 Pro' },
      { name: 'CurrentVersion', type: 'REG_SZ', data: '6.3' },
      { name: 'InstallDate', type: 'REG_DWORD', data: 1704067200 },
      { name: 'PathName', type: 'REG_EXPAND_SZ', data: '%SystemRoot%' }
    ];

    return c.json({ data: mockValues });
  }
);

// GET /api/v1/system-tools/devices/:deviceId/registry/value - Get registry value
systemToolsRoutes.get(
  '/devices/:deviceId/registry/value',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', registryValueQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { hive, path, name } = c.req.valid('query');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    const mockValue: RegistryValue = {
      name: name || '(Default)',
      type: 'REG_SZ',
      data: 'Windows 11 Pro'
    };

    return c.json({
      data: {
        ...mockValue,
        fullPath: `${hive}\\${path}\\${name}`
      }
    });
  }
);

// PUT /api/v1/system-tools/devices/:deviceId/registry/value - Set registry value
systemToolsRoutes.put(
  '/devices/:deviceId/registry/value',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', registryValueBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { hive, path, name, type, data } = c.req.valid('json');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // Audit log for sensitive operation
    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'set_registry_value',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        hive,
        path,
        name,
        type,
        data: typeof data === 'string' ? data.substring(0, 200) : data // Truncate for audit
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: 'success'
    });

    // TODO: Replace with actual agent call
    return c.json({
      success: true,
      message: `Registry value ${name} set successfully`,
      data: {
        hive,
        path,
        name,
        type,
        data
      }
    });
  }
);

// DELETE /api/v1/system-tools/devices/:deviceId/registry/value - Delete registry value
systemToolsRoutes.delete(
  '/devices/:deviceId/registry/value',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', registryValueQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { hive, path, name } = c.req.valid('query');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // Audit log for sensitive operation
    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'delete_registry_value',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        hive,
        path,
        name
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: 'success'
    });

    // TODO: Replace with actual agent call
    return c.json({
      success: true,
      message: `Registry value ${name} deleted successfully`
    });
  }
);

// POST /api/v1/system-tools/devices/:deviceId/registry/key - Create registry key
systemToolsRoutes.post(
  '/devices/:deviceId/registry/key',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', registryKeyBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { hive, path } = c.req.valid('json');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const normalizedPath = path.replace(/\\+$/, '');
    const parts = normalizedPath.split('\\');
    const name = parts.pop();
    const parentPath = parts.join('\\');

    if (!name) {
      return c.json({ error: 'Invalid registry key path' }, 400);
    }

    const overrideKey = `${deviceId}:${hive}:${parentPath}`;
    const overrides = getRegistryOverrides(overrideKey);
    overrides.added.add(name);
    overrides.removed.delete(name);

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'create_registry_key',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        hive,
        path: normalizedPath
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: 'success'
    });

    return c.json({
      success: true,
      message: `Registry key ${normalizedPath} created successfully`
    });
  }
);

// DELETE /api/v1/system-tools/devices/:deviceId/registry/key - Delete registry key
systemToolsRoutes.delete(
  '/devices/:deviceId/registry/key',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', registryKeyQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { hive, path } = c.req.valid('query');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const normalizedPath = path.replace(/\\+$/, '');
    const parts = normalizedPath.split('\\');
    const name = parts.pop();
    const parentPath = parts.join('\\');

    if (!name) {
      return c.json({ error: 'Invalid registry key path' }, 400);
    }

    const overrideKey = `${deviceId}:${hive}:${parentPath}`;
    const overrides = getRegistryOverrides(overrideKey);
    overrides.removed.add(name);
    overrides.added.delete(name);

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'delete_registry_key',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        hive,
        path: normalizedPath
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: 'success'
    });

    return c.json({
      success: true,
      message: `Registry key ${normalizedPath} deleted successfully`
    });
  }
);

// ============================================
// EVENT LOGS ROUTES (Windows)
// ============================================

// GET /api/v1/system-tools/devices/:deviceId/eventlogs - List available logs
systemToolsRoutes.get(
  '/devices/:deviceId/eventlogs',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    const eventLogs = generateMockEventLogs();

    return c.json({ data: eventLogs });
  }
);

// GET /api/v1/system-tools/devices/:deviceId/eventlogs/:name - Get log info
systemToolsRoutes.get(
  '/devices/:deviceId/eventlogs/:name',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', eventLogNameParamSchema),
  async (c) => {
    const { deviceId, name } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    const eventLogs = generateMockEventLogs();
    const eventLog = eventLogs.find(l => l.name === name);

    if (!eventLog) {
      return c.json({ error: 'Event log not found' }, 404);
    }

    return c.json({ data: eventLog });
  }
);

// GET /api/v1/system-tools/devices/:deviceId/eventlogs/:name/events - Query events
systemToolsRoutes.get(
  '/devices/:deviceId/eventlogs/:name/events',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', eventLogNameParamSchema),
  zValidator('query', eventLogQuerySchema),
  async (c) => {
    const { deviceId, name } = c.req.valid('param');
    const query = c.req.valid('query');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    let events = generateMockEventEntries();
    
    // Apply filters
    if (query.level) {
      events = events.filter(e => e.level === query.level);
    }
    if (query.source) {
      events = events.filter(e => e.source.toLowerCase().includes(query.source!.toLowerCase()));
    }
    if (query.eventId) {
      events = events.filter(e => e.eventId === query.eventId);
    }

    const { page, limit, offset } = getPagination(query);
    const paginatedEvents = events.slice(offset, offset + limit);

    return c.json({
      data: paginatedEvents,
      meta: {
        logName: name,
        total: events.length,
        page,
        limit,
        totalPages: Math.ceil(events.length / limit),
        filters: {
          level: query.level,
          source: query.source,
          startTime: query.startTime,
          endTime: query.endTime,
          eventId: query.eventId
        }
      }
    });
  }
);

// GET /api/v1/system-tools/devices/:deviceId/eventlogs/:name/events/:recordId - Get event
systemToolsRoutes.get(
  '/devices/:deviceId/eventlogs/:name/events/:recordId',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', eventRecordParamSchema),
  async (c) => {
    const { deviceId, name, recordId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    const events = generateMockEventEntries();
    const event = events.find(e => e.recordId === recordId);

    if (!event) {
      return c.json({ error: 'Event not found' }, 404);
    }

    return c.json({
      data: {
        ...event,
        logName: name,
        rawXml: '<Event>...</Event>' // Mock XML representation
      }
    });
  }
);

// ============================================
// SCHEDULED TASKS ROUTES (Windows)
// ============================================

// GET /api/v1/system-tools/devices/:deviceId/tasks - List scheduled tasks
systemToolsRoutes.get(
  '/devices/:deviceId/tasks',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', paginationQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    const tasks = generateMockScheduledTasks();
    const { page, limit, offset } = getPagination(c.req.valid('query'));

    const paginatedTasks = tasks.slice(offset, offset + limit);

    return c.json({
      data: paginatedTasks,
      meta: {
        total: tasks.length,
        page,
        limit,
        totalPages: Math.ceil(tasks.length / limit)
      }
    });
  }
);

// GET /api/v1/system-tools/devices/:deviceId/tasks/:path - Get task details
systemToolsRoutes.get(
  '/devices/:deviceId/tasks/:path',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', taskPathParamSchema),
  async (c) => {
    const { deviceId, path } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // Decode the path (URL encoded)
    const decodedPath = decodeURIComponent(path);

    // TODO: Replace with actual agent call
    const tasks = generateMockScheduledTasks();
    const task = tasks.find(t => t.path === decodedPath || t.path.endsWith(decodedPath));

    if (!task) {
      return c.json({ error: 'Scheduled task not found' }, 404);
    }

    return c.json({ data: task });
  }
);

// POST /api/v1/system-tools/devices/:deviceId/tasks/:path/run - Run task
systemToolsRoutes.post(
  '/devices/:deviceId/tasks/:path/run',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', taskPathParamSchema),
  async (c) => {
    const { deviceId, path } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const decodedPath = decodeURIComponent(path);
    const tasks = generateMockScheduledTasks();
    const task = tasks.find(t => t.path === decodedPath || t.path.endsWith(decodedPath));

    if (!task) {
      return c.json({ error: 'Scheduled task not found' }, 404);
    }

    // Audit log for task execution
    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'run_scheduled_task',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        taskPath: decodedPath,
        taskName: task.name
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: 'success'
    });

    // TODO: Replace with actual agent call
    return c.json({
      success: true,
      message: `Scheduled task ${task.name} started`,
      data: { ...task, state: 'running' as const }
    });
  }
);

// POST /api/v1/system-tools/devices/:deviceId/tasks/:path/enable - Enable task
systemToolsRoutes.post(
  '/devices/:deviceId/tasks/:path/enable',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', taskPathParamSchema),
  async (c) => {
    const { deviceId, path } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const decodedPath = decodeURIComponent(path);
    const tasks = generateMockScheduledTasks();
    const task = tasks.find(t => t.path === decodedPath || t.path.endsWith(decodedPath));

    if (!task) {
      return c.json({ error: 'Scheduled task not found' }, 404);
    }

    // Audit log for task enable
    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'enable_scheduled_task',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        taskPath: decodedPath,
        taskName: task.name
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: 'success'
    });

    // TODO: Replace with actual agent call
    return c.json({
      success: true,
      message: `Scheduled task ${task.name} enabled`,
      data: { ...task, state: 'ready' as const }
    });
  }
);

// POST /api/v1/system-tools/devices/:deviceId/tasks/:path/disable - Disable task
systemToolsRoutes.post(
  '/devices/:deviceId/tasks/:path/disable',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', taskPathParamSchema),
  async (c) => {
    const { deviceId, path } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const decodedPath = decodeURIComponent(path);
    const tasks = generateMockScheduledTasks();
    const task = tasks.find(t => t.path === decodedPath || t.path.endsWith(decodedPath));

    if (!task) {
      return c.json({ error: 'Scheduled task not found' }, 404);
    }

    // Audit log for task disable
    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'disable_scheduled_task',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        taskPath: decodedPath,
        taskName: task.name
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: 'success'
    });

    // TODO: Replace with actual agent call
    return c.json({
      success: true,
      message: `Scheduled task ${task.name} disabled`,
      data: { ...task, state: 'disabled' as const }
    });
  }
);

// ============================================
// FILE BROWSER ROUTES
// ============================================

// GET /api/v1/system-tools/devices/:deviceId/files - List files for a path
systemToolsRoutes.get(
  '/devices/:deviceId/files',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', fileListQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { path } = c.req.valid('query');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // Execute file_list command on agent
    const result = await executeCommand(deviceId, CommandTypes.FILE_LIST, {
      path
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Agent failed to list files. The device may be offline.' }, 502);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({ data: data.entries || [] });
    } catch {
      return c.json({ error: 'Failed to parse agent response for file listing' }, 502);
    }
  }
);

// POST /api/v1/system-tools/devices/:deviceId/files/upload - Upload a file
systemToolsRoutes.post(
  '/devices/:deviceId/files/upload',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const body = await c.req.json<{
      path: string;
      content: string;
      encoding?: 'base64' | 'text';
    }>();

    if (!body.path || typeof body.path !== 'string') {
      return c.json({ error: 'path is required' }, 400);
    }
    if (body.content === undefined || typeof body.content !== 'string') {
      return c.json({ error: 'content is required' }, 400);
    }

    const result = await executeCommand(deviceId, CommandTypes.FILE_WRITE, {
      path: body.path,
      content: body.content,
      encoding: body.encoding || 'text'
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    // Audit log after command execution with actual result
    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'file_upload',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        path: body.path,
        encoding: body.encoding || 'text',
        sizeBytes: body.content.length
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: result.status === 'failed' ? 'failure' : 'success'
    });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to write file' }, 500);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({
        success: true,
        data: {
          path: data.path || body.path,
          size: data.size || 0,
          written: true
        }
      });
    } catch {
      return c.json({
        success: true,
        data: { path: body.path, written: true }
      });
    }
  }
);
