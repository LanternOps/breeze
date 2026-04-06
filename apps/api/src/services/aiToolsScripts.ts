/**
 * AI Script & Command Execution Tools
 *
 * Tools for executing commands, running scripts, managing processes,
 * scheduled tasks, registry operations, and browsing the script library.
 *
 * - execute_command (Tier 3): Execute a system command on a device
 * - run_script (Tier 3): Execute a script on one or more devices
 * - manage_services (Tier 3): List, start, stop, or restart system services
 * - list_scripts (Tier 1): Search and filter scripts in the org library
 * - get_script_details (Tier 1): Get full script details with content/versions/stats
 * - list_script_templates (Tier 1): Browse available script templates
 * - get_script_execution_history (Tier 1): Get past execution results for a script
 * - search_script_library (Tier 1): Search scripts and templates together
 * - manage_processes (Tier 1): List or kill running processes on a device
 * - manage_scheduled_tasks (Tier 1): List/run/enable/disable/delete scheduled tasks
 * - registry_operations (Tier 1): Read or modify Windows registry keys/values
 */

import { db } from '../db';
import {
  devices,
  scripts,
  scriptVersions,
  scriptTemplates,
  scriptExecutions,
} from '../db/schema';
import { eq, and, desc, sql, ilike, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import { escapeLike } from '../utils/sql';
import type { AiTool } from './aiTools';

type AiToolTier = 1 | 2 | 3 | 4;

// ============================================
// Cached dynamic import for commandQueue
// ============================================

let _commandQueue: typeof import('./commandQueue') | null = null;
async function getCommandQueue() {
  if (!_commandQueue) _commandQueue = await import('./commandQueue');
  return _commandQueue;
}

// ============================================
// Shared helpers
// ============================================

async function verifyDeviceAccess(
  deviceId: string,
  auth: AuthContext,
  requireOnline = false
): Promise<{ device: typeof devices.$inferSelect } | { error: string }> {
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) conditions.push(orgCond);
  const [device] = await db.select().from(devices).where(and(...conditions)).limit(1);
  if (!device) return { error: 'Device not found or access denied' };
  if (requireOnline && device.status !== 'online') return { error: `Device ${device.hostname} is not online (status: ${device.status})` };
  return { device };
}

export function registerScriptTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // execute_command - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'execute_command',
      description: 'Execute a system command on a device. Requires user approval. Use for process management, service control, file operations, etc.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          commandType: {
            type: 'string',
            enum: [
              'list_processes', 'kill_process',
              'list_services', 'start_service', 'stop_service', 'restart_service',
              'file_list', 'file_read',
              'event_logs_list', 'event_logs_query'
            ],
            description: 'The type of command to execute'
          },
          payload: { type: 'object', description: 'Command-specific parameters' }
        },
        required: ['deviceId', 'commandType']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;

      // Verify device access
      const access = await verifyDeviceAccess(deviceId, auth, true);
      if ('error' in access) return JSON.stringify({ error: access.error });
      const { device } = access;

      // Import and use executeCommand from commandQueue
      const { executeCommand } = await getCommandQueue();
      const result = await executeCommand(deviceId, input.commandType as string, (input.payload as Record<string, unknown>) ?? {}, {
        userId: auth.user.id,
        timeoutMs: 30000
      });

      return JSON.stringify(result);
    }
  });

  // ============================================
  // run_script - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'run_script',
      description: 'Execute a script on one or more devices. Existing scripts can be referenced by ID; inline scripts require approval.',
      input_schema: {
        type: 'object' as const,
        properties: {
          scriptId: { type: 'string', description: 'UUID of an existing script to run' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Device UUIDs to run on' },
          parameters: { type: 'object', description: 'Script parameters' }
        },
        required: ['scriptId', 'deviceIds']
      }
    },
    handler: async (input, auth) => {
      const { executeCommand } = await getCommandQueue();
      const deviceIds = input.deviceIds as string[];
      const results: Record<string, unknown> = {};

      // Resolve script content upfront so the agent receives the full payload
      const scriptConditions: SQL[] = [eq(scripts.id, input.scriptId as string)];
      const orgCond = auth.orgCondition(scripts.orgId);
      if (orgCond) scriptConditions.push(orgCond);

      const [script] = await db
        .select({
          id: scripts.id,
          language: scripts.language,
          content: scripts.content,
          timeoutSeconds: scripts.timeoutSeconds,
          runAs: scripts.runAs,
        })
        .from(scripts)
        .where(and(...scriptConditions))
        .limit(1);

      if (!script || !script.content) {
        return JSON.stringify({ error: 'Script not found or has no content' });
      }

      for (const deviceId of deviceIds.slice(0, 10)) { // Limit to 10 devices
        try {
          // Verify access
          const access = await verifyDeviceAccess(deviceId, auth);
          if ('error' in access) {
            results[deviceId] = { error: access.error };
            continue;
          }

          const result = await executeCommand(deviceId, 'script', {
            scriptId: script.id,
            language: script.language,
            content: script.content,
            timeoutSeconds: script.timeoutSeconds,
            runAs: script.runAs,
            parameters: input.parameters ?? {}
          }, { userId: auth.user.id, timeoutMs: 60000 });

          results[deviceId] = result;
        } catch (err) {
          results[deviceId] = { error: err instanceof Error ? err.message : 'Execution failed' };
        }
      }

      return JSON.stringify({ results });
    }
  });

  // ============================================
  // manage_services - Tier 3 for start/stop/restart
  // ============================================

  registerTool({
    tier: 3,
    definition: {
      name: 'manage_services',
      description: 'List, start, stop, or restart system services on a device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          action: { type: 'string', enum: ['list', 'start', 'stop', 'restart'], description: 'Action to perform' },
          serviceName: { type: 'string', description: 'Service name (required for start/stop/restart)' }
        },
        required: ['deviceId', 'action']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const action = input.action as string;

      const access = await verifyDeviceAccess(deviceId, auth, true);
      if ('error' in access) return JSON.stringify({ error: access.error });

      const { executeCommand } = await getCommandQueue();
      const commandTypeMap: Record<string, string> = {
        list: 'list_services',
        start: 'start_service',
        stop: 'stop_service',
        restart: 'restart_service'
      };

      const commandType = commandTypeMap[action];
      if (!commandType) return JSON.stringify({ error: `Unknown action: ${action}` });

      const result = await executeCommand(deviceId, commandType, {
        name: input.serviceName
      }, { userId: auth.user.id, timeoutMs: 30000 });

      return JSON.stringify(result);
    }
  });

  // ============================================
  // manage_processes - Tier 1 (list), Tier 3 via guardrails (kill)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'manage_processes',
      description: 'List running processes on a device with CPU and memory usage, or terminate a process.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'kill'],
            description: 'Action to perform'
          },
          deviceId: { type: 'string', description: 'The device UUID' },
          processId: { type: 'string', description: 'The PID of the process to kill (required for kill action)' },
          search: { type: 'string', description: 'Filter process list by name' },
          sortBy: {
            type: 'string',
            enum: ['cpu', 'memory', 'name', 'pid'],
            description: 'Sort process list by field (default: cpu)'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of processes to return (default: 50, max: 200)'
          }
        },
        required: ['action', 'deviceId']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const action = input.action as string;

      const access = await verifyDeviceAccess(deviceId, auth, true);
      if ('error' in access) return JSON.stringify({ error: access.error });

      const { executeCommand } = await getCommandQueue();

      if (action === 'list') {
        const limit = Math.min(Math.max(1, Number(input.limit) || 50), 200);
        const result = await executeCommand(deviceId, 'list_processes', {
          search: input.search ?? undefined,
          sortBy: input.sortBy ?? 'cpu',
          limit
        }, { userId: auth.user.id, timeoutMs: 30000 });

        return JSON.stringify(result);
      }

      if (action === 'kill') {
        if (!input.processId) {
          return JSON.stringify({ error: 'processId is required for kill action' });
        }

        const result = await executeCommand(deviceId, 'kill_process', {
          pid: input.processId
        }, { userId: auth.user.id, timeoutMs: 30000 });

        return JSON.stringify(result);
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  });

  // ============================================
  // list_scripts - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'list_scripts',
      description: 'Search and filter scripts in the organization library. Returns a list of matching scripts including name, description, language, OS targets, and category.',
      input_schema: {
        type: 'object' as const,
        properties: {
          search: { type: 'string', description: 'Search by script name (partial match)' },
          category: { type: 'string', description: 'Filter by script category' },
          language: { type: 'string', enum: ['powershell', 'bash', 'python', 'cmd'], description: 'Filter by script language' },
          osType: { type: 'string', enum: ['windows', 'macos', 'linux'], description: 'Filter by OS type (scripts targeting this OS)' },
          limit: { type: 'number', description: 'Max results to return (default 20, max 50)' },
        },
      },
    },
    handler: async (input, auth) => {
      const conditions: SQL[] = [];
      const orgCondition = auth.orgCondition(scripts.orgId);
      if (orgCondition) conditions.push(orgCondition);

      if (input.search) {
        const searchPattern = '%' + escapeLike(input.search as string) + '%';
        conditions.push(sql`${scripts.name} ILIKE ${searchPattern}`);
      }
      if (input.category) conditions.push(eq(scripts.category, input.category as string));
      if (input.language) conditions.push(eq(scripts.language, input.language as typeof scripts.language.enumValues[number]));
      if (input.osType) conditions.push(sql`${scripts.osTypes} @> ARRAY[${input.osType}]::text[]`);

      const limit = Math.min(Math.max(1, Number(input.limit) || 20), 50);

      const results = await db
        .select({
          id: scripts.id,
          name: scripts.name,
          description: scripts.description,
          language: scripts.language,
          osTypes: scripts.osTypes,
          category: scripts.category,
          createdAt: scripts.createdAt,
        })
        .from(scripts)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(scripts.updatedAt))
        .limit(limit);

      return JSON.stringify({ scripts: results, count: results.length });
    },
  });

  // ============================================
  // get_script_details - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_script_details',
      description: 'Get full script details including content, parameters, version history, and execution statistics.',
      input_schema: {
        type: 'object' as const,
        properties: {
          scriptId: { type: 'string', description: 'UUID of the script' },
          includeContent: { type: 'boolean', description: 'Include the script content (default true)' },
          includeVersionHistory: { type: 'boolean', description: 'Include version history (default false)' },
          includeExecutionStats: { type: 'boolean', description: 'Include execution statistics (default false)' },
        },
        required: ['scriptId'],
      },
    },
    handler: async (input, auth) => {
      const scriptId = input.scriptId as string;
      const includeContent = (input.includeContent as boolean) ?? true;
      const includeVersionHistory = (input.includeVersionHistory as boolean) ?? false;
      const includeExecutionStats = (input.includeExecutionStats as boolean) ?? false;

      // Query script with org scoping
      const conditions: SQL[] = [eq(scripts.id, scriptId)];
      const orgCond = auth.orgCondition(scripts.orgId);
      if (orgCond) conditions.push(orgCond);

      const [script] = await db
        .select()
        .from(scripts)
        .where(and(...conditions))
        .limit(1);

      if (!script) {
        return JSON.stringify({ error: 'Script not found or access denied' });
      }

      const result: Record<string, unknown> = {
        id: script.id,
        name: script.name,
        description: script.description,
        category: script.category,
        language: script.language,
        osTypes: script.osTypes,
        parameters: script.parameters,
        timeoutSeconds: script.timeoutSeconds,
        runAs: script.runAs,
        isSystem: script.isSystem,
        version: script.version,
        createdBy: script.createdBy,
        createdAt: script.createdAt,
        updatedAt: script.updatedAt,
      };

      if (includeContent) {
        result.content = script.content;
      }

      if (includeVersionHistory) {
        const versions = await db
          .select({
            id: scriptVersions.id,
            version: scriptVersions.version,
            changelog: scriptVersions.changelog,
            createdBy: scriptVersions.createdBy,
            createdAt: scriptVersions.createdAt,
          })
          .from(scriptVersions)
          .where(eq(scriptVersions.scriptId, scriptId))
          .orderBy(desc(scriptVersions.version))
          .limit(10);

        result.versionHistory = versions;
      }

      if (includeExecutionStats) {
        const [stats] = await db
          .select({
            totalExecutions: sql<number>`count(*)::int`,
            completedCount: sql<number>`count(*) filter (where ${scriptExecutions.status} = 'completed')::int`,
            failedCount: sql<number>`count(*) filter (where ${scriptExecutions.status} = 'failed')::int`,
            pendingCount: sql<number>`count(*) filter (where ${scriptExecutions.status} = 'pending')::int`,
            runningCount: sql<number>`count(*) filter (where ${scriptExecutions.status} = 'running')::int`,
            timeoutCount: sql<number>`count(*) filter (where ${scriptExecutions.status} = 'timeout')::int`,
            cancelledCount: sql<number>`count(*) filter (where ${scriptExecutions.status} = 'cancelled')::int`,
            avgDurationSeconds: sql<number>`avg(extract(epoch from (${scriptExecutions.completedAt} - ${scriptExecutions.startedAt})))::numeric(10,2)`,
          })
          .from(scriptExecutions)
          .where(eq(scriptExecutions.scriptId, scriptId));

        result.executionStats = stats;
      }

      return JSON.stringify(result);
    },
  });

  // ============================================
  // list_script_templates - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'list_script_templates',
      description: 'Browse available script templates for common tasks. Templates are pre-built scripts that can be used as starting points.',
      input_schema: {
        type: 'object' as const,
        properties: {
          search: { type: 'string', description: 'Search by template name (partial match)' },
          category: { type: 'string', description: 'Filter by template category' },
          limit: { type: 'number', description: 'Max results to return (default 20, max 50)' },
        },
      },
    },
    handler: async (input, _auth) => {
      const conditions: SQL[] = [];

      if (input.search) {
        const searchPattern = '%' + escapeLike(input.search as string) + '%';
        conditions.push(sql`${scriptTemplates.name} ILIKE ${searchPattern}`);
      }
      if (input.category) conditions.push(eq(scriptTemplates.category, input.category as string));

      const limit = Math.min(Math.max(1, Number(input.limit) || 20), 50);

      const results = await db
        .select({
          id: scriptTemplates.id,
          name: scriptTemplates.name,
          description: scriptTemplates.description,
          language: scriptTemplates.language,
          category: scriptTemplates.category,
          rating: scriptTemplates.rating,
        })
        .from(scriptTemplates)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(scriptTemplates.rating))
        .limit(limit);

      return JSON.stringify({ templates: results, count: results.length });
    },
  });

  // ============================================
  // get_script_execution_history - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_script_execution_history',
      description: 'Get past execution results for a script. Shows status, exit codes, stdout/stderr, and timing information.',
      input_schema: {
        type: 'object' as const,
        properties: {
          scriptId: { type: 'string', description: 'UUID of the script to get execution history for' },
          limit: { type: 'number', description: 'Max results to return (default 10, max 50)' },
        },
        required: ['scriptId'],
      },
    },
    handler: async (input, auth) => {
      // Verify the script belongs to the user's org before returning execution data
      const scriptConditions: SQL[] = [eq(scripts.id, input.scriptId as string)];
      const orgCondition = auth.orgCondition(scripts.orgId);
      if (orgCondition) scriptConditions.push(orgCondition);

      const [script] = await db
        .select({ id: scripts.id })
        .from(scripts)
        .where(and(...scriptConditions))
        .limit(1);

      if (!script) return JSON.stringify({ error: 'Script not found' });

      const limit = Math.min(Math.max(1, Number(input.limit) || 10), 50);

      const results = await db
        .select({
          id: scriptExecutions.id,
          status: scriptExecutions.status,
          exitCode: scriptExecutions.exitCode,
          stdout: scriptExecutions.stdout,
          stderr: scriptExecutions.stderr,
          createdAt: scriptExecutions.createdAt,
          completedAt: scriptExecutions.completedAt,
        })
        .from(scriptExecutions)
        .where(eq(scriptExecutions.scriptId, input.scriptId as string))
        .orderBy(desc(scriptExecutions.createdAt))
        .limit(limit);

      return JSON.stringify({ executions: results, count: results.length });
    },
  });

  // ============================================
  // search_script_library - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'search_script_library',
      description: 'Search the script library including org scripts and built-in templates. Filter by category, language, OS, or search text.',
      input_schema: {
        type: 'object' as const,
        properties: {
          search: { type: 'string', description: 'Partial match on script name or description' },
          category: { type: 'string', description: 'Filter by category name' },
          language: { type: 'string', enum: ['powershell', 'bash', 'python', 'cmd', 'zsh'], description: 'Filter by scripting language' },
          osType: { type: 'string', enum: ['windows', 'macos', 'linux'], description: 'Filter by supported OS (checks osTypes array)' },
          includeTemplates: { type: 'boolean', description: 'Include built-in script templates (default false)' },
          limit: { type: 'number', description: 'Max results to return (default 25, max 100)' },
        },
      },
    },
    handler: async (input, auth) => {
      const limit = Math.min(Math.max((input.limit as number) || 25, 1), 100);
      const search = input.search as string | undefined;
      const category = input.category as string | undefined;
      const language = input.language as string | undefined;
      const osType = input.osType as string | undefined;
      const includeTemplates = (input.includeTemplates as boolean) ?? false;

      // Query org scripts
      const conditions: SQL[] = [];
      const orgCond = auth.orgCondition(scripts.orgId);
      if (orgCond) conditions.push(orgCond);

      if (search) {
        const pattern = '%' + escapeLike(search) + '%';
        conditions.push(
          sql`(${scripts.name} ILIKE ${pattern} OR ${scripts.description} ILIKE ${pattern})`
        );
      }
      if (category) conditions.push(eq(scripts.category, category));
      if (language) conditions.push(eq(scripts.language, language as typeof scripts.language.enumValues[number]));
      if (osType) conditions.push(sql`${sql.param(osType)} = ANY(${scripts.osTypes})`);

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const orgScripts = await db
        .select({
          id: scripts.id,
          name: scripts.name,
          description: scripts.description,
          category: scripts.category,
          language: scripts.language,
          osTypes: scripts.osTypes,
          version: scripts.version,
          isSystem: scripts.isSystem,
          createdAt: scripts.createdAt,
        })
        .from(scripts)
        .where(whereClause)
        .orderBy(desc(scripts.updatedAt))
        .limit(limit);

      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(scripts)
        .where(whereClause);
      const totalOrgScripts = countResult?.count ?? 0;

      // Optionally query built-in templates
      let templates: Array<{
        id: string;
        name: string;
        description: string | null;
        category: string | null;
        language: string | null;
        isBuiltIn: boolean;
        source: string;
      }> = [];
      let totalTemplates = 0;

      if (includeTemplates) {
        const tplConditions: SQL[] = [];
        if (search) {
          const pattern = '%' + escapeLike(search) + '%';
          tplConditions.push(
            sql`(${scriptTemplates.name} ILIKE ${pattern} OR ${scriptTemplates.description} ILIKE ${pattern})`
          );
        }
        if (category) tplConditions.push(eq(scriptTemplates.category, category));
        if (language) tplConditions.push(eq(scriptTemplates.language, language as typeof scriptTemplates.language.enumValues[number]));

        const tplWhere = tplConditions.length > 0 ? and(...tplConditions) : undefined;

        const tplRows = await db
          .select({
            id: scriptTemplates.id,
            name: scriptTemplates.name,
            description: scriptTemplates.description,
            category: scriptTemplates.category,
            language: scriptTemplates.language,
            isBuiltIn: scriptTemplates.isBuiltIn,
          })
          .from(scriptTemplates)
          .where(tplWhere)
          .limit(limit);

        templates = tplRows.map(t => ({ ...t, source: 'template' }));

        const [tplCount] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(scriptTemplates)
          .where(tplWhere);
        totalTemplates = tplCount?.count ?? 0;
      }

      return JSON.stringify({
        scripts: orgScripts.map(s => ({ ...s, source: 'library' })),
        templates,
        totalMatches: totalOrgScripts + totalTemplates,
        totalOrgScripts,
        totalTemplates,
      });
    },
  });

  // ============================================
  // manage_scheduled_tasks - Tier 1 base, with action escalation
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'manage_scheduled_tasks',
      description: 'List, run, enable, disable, or delete Windows scheduled tasks on a device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          action: {
            type: 'string',
            enum: ['list', 'run', 'disable', 'enable', 'delete'],
            description: 'Action to perform on scheduled tasks'
          },
          taskName: { type: 'string', description: 'Task name (required for run/disable/enable/delete)' },
          search: { type: 'string', description: 'Filter task list by name (only for list action)' }
        },
        required: ['deviceId', 'action']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const action = input.action as string;

      const access = await verifyDeviceAccess(deviceId, auth, true);
      if ('error' in access) return JSON.stringify({ error: access.error });

      const { executeCommand } = await getCommandQueue();
      const commandTypeMap: Record<string, string> = {
        list: 'scheduled_tasks_list',
        run: 'scheduled_tasks_run',
        disable: 'scheduled_tasks_disable',
        enable: 'scheduled_tasks_enable',
        delete: 'scheduled_tasks_delete'
      };

      const commandType = commandTypeMap[action];
      if (!commandType) return JSON.stringify({ error: `Unknown action: ${action}` });

      const payload: Record<string, unknown> = {};
      if (action === 'list') {
        if (input.search) payload.search = input.search;
      } else {
        if (!input.taskName) return JSON.stringify({ error: 'taskName is required for this action' });
        payload.taskName = input.taskName;
      }

      const result = await executeCommand(deviceId, commandType, payload, {
        userId: auth.user.id,
        timeoutMs: 30000
      });

      return JSON.stringify(result);
    }
  });

  // ============================================
  // registry_operations - Tier 1 base, with action escalation
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'registry_operations',
      description: 'Read or modify Windows registry keys and values on a device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['read_key', 'get_value', 'set_value', 'create_key', 'delete_key'],
            description: 'Registry operation to perform'
          },
          deviceId: { type: 'string', description: 'The device UUID' },
          keyPath: {
            type: 'string',
            description: 'Full registry key path (e.g. HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion)'
          },
          valueName: { type: 'string', description: 'Registry value name (for get_value/set_value)' },
          valueData: { type: 'string', description: 'Data to write (for set_value)' },
          valueType: {
            type: 'string',
            enum: ['REG_SZ', 'REG_DWORD', 'REG_QWORD', 'REG_BINARY', 'REG_EXPAND_SZ', 'REG_MULTI_SZ'],
            description: 'Registry value type (for set_value)'
          }
        },
        required: ['action', 'deviceId', 'keyPath']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const action = input.action as string;

      const access = await verifyDeviceAccess(deviceId, auth, true);
      if ('error' in access) return JSON.stringify({ error: access.error });

      const { executeCommand } = await getCommandQueue();

      const commandTypeMap: Record<string, string> = {
        read_key: 'registry_read_key',
        get_value: 'registry_get_value',
        set_value: 'registry_set_value',
        create_key: 'registry_create_key',
        delete_key: 'registry_delete_key',
      };

      const commandType = commandTypeMap[action];
      if (!commandType) return JSON.stringify({ error: `Unknown action: ${action}` });

      const payload: Record<string, unknown> = {
        keyPath: input.keyPath,
      };

      if (input.valueName) payload.valueName = input.valueName;
      if (input.valueData !== undefined) payload.valueData = input.valueData;
      if (input.valueType) payload.valueType = input.valueType;

      const result = await executeCommand(deviceId, commandType, payload, {
        userId: auth.user.id,
        timeoutMs: 30000,
      });

      return JSON.stringify(result);
    }
  });
}
