/**
 * AI Device Management Tools
 *
 * Tools for querying, inspecting, and managing individual devices.
 * - query_devices (Tier 1): Search and filter devices
 * - get_device_details (Tier 1): Comprehensive device info with hardware/network/metrics
 * - get_device_context (Tier 1): Retrieve AI memory about a device
 * - set_device_context (Tier 2): Record context/memory about a device
 * - resolve_device_context (Tier 2): Mark context entry as resolved
 * - manage_tags (Tier 2): List/add/remove device tags
 * - query_custom_fields (Tier 1): Get custom field definitions or device values
 */

import { db } from '../db';
import {
  devices,
  deviceHardware,
  deviceNetwork,
  deviceDisks,
  deviceMetrics,
  sites,
  customFieldDefinitions,
} from '../db/schema';
import { eq, and, desc, sql, SQL } from 'drizzle-orm';
import { escapeLike } from '../utils/sql';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { verifyDeviceAccess } from './aiTools';
import {
  getActiveDeviceContext,
  getAllDeviceContext,
  createDeviceContext,
  resolveDeviceContext,
} from './brainDeviceContext';

type AiToolTier = 1 | 2 | 3 | 4;

export function registerDeviceTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // query_devices - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'query_devices',
      description: 'Search and filter devices in the organization. Returns a summary list of matching devices including hostname, OS, status, IP, and last seen time.',
      input_schema: {
        type: 'object' as const,
        properties: {
          status: { type: 'string', enum: ['online', 'offline', 'maintenance', 'decommissioned'], description: 'Filter by device status' },
          osType: { type: 'string', enum: ['windows', 'macos', 'linux'], description: 'Filter by operating system type' },
          siteId: { type: 'string', description: 'Filter by site UUID' },
          search: { type: 'string', description: 'Search by hostname or display name (partial match)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (devices must have all specified tags)' },
          limit: { type: 'number', description: 'Max results to return (default 25, max 100)' }
        }
      }
    },
    handler: async (input, auth) => {
      const conditions: SQL[] = [];
      const orgCondition = auth.orgCondition(devices.orgId);
      if (orgCondition) conditions.push(orgCondition);

      if (input.status) conditions.push(eq(devices.status, input.status as typeof devices.status.enumValues[number]));
      if (input.osType) conditions.push(eq(devices.osType, input.osType as typeof devices.osType.enumValues[number]));
      if (input.siteId) {
        conditions.push(eq(devices.siteId, input.siteId as string));
      }
      if (input.search) {
        const searchPattern = '%' + escapeLike(input.search as string) + '%';
        conditions.push(
          sql`(${devices.hostname} ILIKE ${searchPattern} OR ${devices.displayName} ILIKE ${searchPattern})`
        );
      }

      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);

      const results = await db
        .select({
          id: devices.id,
          hostname: devices.hostname,
          displayName: devices.displayName,
          osType: devices.osType,
          osVersion: devices.osVersion,
          status: devices.status,
          agentVersion: devices.agentVersion,
          lastSeenAt: devices.lastSeenAt,
          tags: devices.tags,
          siteName: sites.name
        })
        .from(devices)
        .leftJoin(sites, eq(devices.siteId, sites.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(devices.lastSeenAt))
        .limit(limit);

      // Get count
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(devices)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      const total = Number(countResult[0]?.count ?? 0);

      return JSON.stringify({
        devices: results,
        total,
        showing: results.length
      });
    }
  });

  // ============================================
  // get_device_details - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_device_details',
      description: 'Get comprehensive details about a specific device including hardware specs, network interfaces, disk usage, and recent metrics.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' }
        },
        required: ['deviceId']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;

      const access = await verifyDeviceAccess(deviceId, auth);
      if ('error' in access) return JSON.stringify({ error: access.error });
      const { device } = access;

      // Fetch related data in parallel
      const [hardware, network, disks, recentMetrics] = await Promise.all([
        db.select().from(deviceHardware).where(eq(deviceHardware.deviceId, deviceId)).limit(1),
        db.select().from(deviceNetwork).where(eq(deviceNetwork.deviceId, deviceId)),
        db.select().from(deviceDisks).where(eq(deviceDisks.deviceId, deviceId)),
        db.select().from(deviceMetrics)
          .where(eq(deviceMetrics.deviceId, deviceId))
          .orderBy(desc(deviceMetrics.timestamp))
          .limit(5)
      ]);

      // Get site name
      const [site] = await db
        .select({ name: sites.name })
        .from(sites)
        .where(eq(sites.id, device.siteId))
        .limit(1);

      return JSON.stringify({
        device: {
          ...device,
          siteName: site?.name
        },
        hardware: hardware[0] ?? null,
        networkInterfaces: network,
        disks,
        recentMetrics
      }, (_, v) => typeof v === 'bigint' ? Number(v) : v);
    }
  });

  // ============================================
  // get_device_context - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'get_device_context',
      description: 'Retrieve past AI memory/context about a device. Returns known issues, quirks, follow-ups, and preferences from previous interactions. Use this AUTOMATICALLY when asked about a device to recall past conversations and context.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: {
            type: 'string',
            description: 'UUID of the device to get context for',
          },
          includeResolved: {
            type: 'boolean',
            description: 'Include resolved/completed context entries (default: false)',
            default: false,
          },
        },
        required: ['deviceId'],
      },
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const includeResolved = Boolean(input.includeResolved);

      // Verify device exists and user has access
      const access = await verifyDeviceAccess(deviceId, auth);
      if ('error' in access) return JSON.stringify({ error: access.error });

      const results = includeResolved
        ? await getAllDeviceContext(deviceId, auth)
        : await getActiveDeviceContext(deviceId, auth);

      if (results.length === 0) {
        return 'No context found for this device. This is a fresh start with no previous memory.';
      }

      const formatted = results.map(r => {
        const status = r.resolvedAt
          ? 'RESOLVED'
          : r.expiresAt && r.expiresAt < new Date()
          ? 'EXPIRED'
          : 'ACTIVE';

        let output = `[${status}] ${r.contextType.toUpperCase()}: ${r.summary}`;
        if (r.details) {
          output += `\nDetails: ${JSON.stringify(r.details, null, 2)}`;
        }
        output += `\nRecorded: ${r.createdAt.toISOString()} | ID: ${r.id}`;
        if (r.resolvedAt) {
          output += `\nResolved: ${r.resolvedAt.toISOString()}`;
        }
        return output;
      });

      return `Found ${results.length} context entries:\n\n${formatted.join('\n\n---\n\n')}`;
    },
  });

  // ============================================
  // set_device_context - Tier 2 (audit)
  // ============================================

  registerTool({
    tier: 2,
    definition: {
      name: 'set_device_context',
      description: 'Record new context/memory about a device for future reference. Use this to remember issues, quirks, follow-ups, or preferences discovered during troubleshooting. This helps maintain continuity across conversations.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: {
            type: 'string',
            description: 'UUID of the device',
          },
          contextType: {
            type: 'string',
            enum: ['issue', 'quirk', 'followup', 'preference'],
            description: 'Type of context: issue (known problem), quirk (device behavior), followup (action item), preference (user config)',
          },
          summary: {
            type: 'string',
            description: 'Brief summary (max 255 chars)',
          },
          details: {
            type: 'object',
            description: 'Optional structured details as JSON object',
          },
          expiresInDays: {
            type: 'number',
            description: 'Optional expiration in days (1-365). Use for temporary notes or time-bound follow-ups.',
          },
        },
        required: ['deviceId', 'contextType', 'summary'],
      },
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const contextType = input.contextType as 'issue' | 'quirk' | 'followup' | 'preference';
      const summary = input.summary as string;
      const details = (input.details as Record<string, unknown>) ?? null;
      const expiresInDays = input.expiresInDays as number | undefined;

      const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
        : undefined;

      const result = await createDeviceContext(
        deviceId,
        contextType,
        summary,
        details,
        auth,
        expiresAt
      );

      if ('error' in result) {
        return JSON.stringify({ error: result.error });
      }

      return `Context recorded successfully (ID: ${result.id}). This will be remembered in future conversations about this device.`;
    },
  });

  // ============================================
  // resolve_device_context - Tier 2 (audit)
  // ============================================

  registerTool({
    tier: 2,
    definition: {
      name: 'resolve_device_context',
      description: 'Mark a context entry as resolved/completed. Use this when an issue is fixed or a follow-up is completed. Resolved items are hidden from active context but preserved in history.',
      input_schema: {
        type: 'object' as const,
        properties: {
          contextId: {
            type: 'string',
            description: 'UUID of the context entry to resolve',
          },
        },
        required: ['contextId'],
      },
    },
    handler: async (input, auth) => {
      const contextId = input.contextId as string;
      const { updated } = await resolveDeviceContext(contextId, auth);
      if (!updated) {
        return JSON.stringify({ error: 'Context entry not found or access denied' });
      }
      return 'Context entry marked as resolved.';
    },
  });

  // ============================================
  // manage_tags - Tier 2 (auto-execute + audit)
  // ============================================

  registerTool({
    tier: 2,
    definition: {
      name: 'manage_tags',
      description: 'List all tags used across devices, or add/remove tags on a specific device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'add', 'remove'],
            description: 'Action to perform: list all tags, add tags to a device, or remove tags from a device'
          },
          deviceId: { type: 'string', description: 'Device UUID (required for add/remove)' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags to add or remove (required for add/remove)'
          },
          search: { type: 'string', description: 'Filter tag list by partial match (only for list action)' }
        },
        required: ['action']
      }
    },
    handler: async (input, auth) => {
      const action = input.action as string;

      if (action === 'list') {
        const conditions: SQL[] = [];
        const orgCond = auth.orgCondition(devices.orgId);
        if (orgCond) conditions.push(orgCond);

        const search = input.search as string | undefined;
        const whereClause = conditions.length > 0 ? and(...conditions) : sql`true`;

        const tagRows = await db.execute<{ tag: string }>(
          search
            ? sql`SELECT DISTINCT tag FROM (SELECT unnest(tags) AS tag FROM devices WHERE ${whereClause}) t WHERE tag ILIKE ${'%' + escapeLike(search) + '%'} ORDER BY tag`
            : sql`SELECT DISTINCT unnest(tags) AS tag FROM devices WHERE ${whereClause} ORDER BY tag`
        );

        const tags = (tagRows as unknown as { tag: string }[]).map((r) => r.tag);
        return JSON.stringify({ tags, total: tags.length });
      }

      if (action === 'add' || action === 'remove') {
        const deviceId = input.deviceId as string;
        const tagsInput = input.tags as string[];

        if (!deviceId) return JSON.stringify({ error: 'deviceId is required for add/remove' });
        if (!tagsInput || tagsInput.length === 0) return JSON.stringify({ error: 'tags array is required for add/remove' });

        const access = await verifyDeviceAccess(deviceId, auth);
        if ('error' in access) return JSON.stringify({ error: access.error });

        if (action === 'add') {
          const tagsArray = sql`${tagsInput}::text[]`;
          await db.execute(
            sql`UPDATE devices SET tags = (SELECT array_agg(DISTINCT t) FROM unnest(array_cat(tags, ${tagsArray})) t), updated_at = now() WHERE id = ${deviceId}`
          );
        } else {
          for (const tag of tagsInput) {
            await db.execute(
              sql`UPDATE devices SET tags = array_remove(tags, ${tag}), updated_at = now() WHERE id = ${deviceId}`
            );
          }
        }

        const [updated] = await db
          .select({ tags: devices.tags })
          .from(devices)
          .where(eq(devices.id, deviceId))
          .limit(1);

        return JSON.stringify({
          success: true,
          action,
          deviceId,
          tags: updated?.tags ?? []
        });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  });

  // ============================================
  // query_custom_fields - Tier 1 (read-only)
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'query_custom_fields',
      description: 'Get custom field definitions for the organization, or get custom field values for a specific device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['list_definitions', 'get_device_values'],
            description: 'Action: list_definitions to see available fields, get_device_values to see a device\'s field values'
          },
          deviceId: { type: 'string', description: 'Device UUID (required for get_device_values)' }
        },
        required: ['action']
      }
    },
    handler: async (input, auth) => {
      const action = input.action as string;

      if (action === 'list_definitions') {
        const conditions: SQL[] = [];
        if (auth.orgId) {
          conditions.push(
            sql`(${customFieldDefinitions.orgId} = ${auth.orgId} OR ${customFieldDefinitions.orgId} IS NULL)`
          );
        }
        if (auth.partnerId) {
          conditions.push(
            sql`(${customFieldDefinitions.partnerId} = ${auth.partnerId} OR ${customFieldDefinitions.partnerId} IS NULL)`
          );
        }

        const definitions = await db
          .select({
            id: customFieldDefinitions.id,
            name: customFieldDefinitions.name,
            fieldKey: customFieldDefinitions.fieldKey,
            type: customFieldDefinitions.type,
            required: customFieldDefinitions.required,
            options: customFieldDefinitions.options,
            deviceTypes: customFieldDefinitions.deviceTypes,
            defaultValue: customFieldDefinitions.defaultValue,
          })
          .from(customFieldDefinitions)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(customFieldDefinitions.name);

        return JSON.stringify({ definitions, total: definitions.length });
      }

      if (action === 'get_device_values') {
        const deviceId = input.deviceId as string;
        if (!deviceId) return JSON.stringify({ error: 'deviceId is required for get_device_values' });

        const access = await verifyDeviceAccess(deviceId, auth);
        if ('error' in access) return JSON.stringify({ error: access.error });
        const { device } = access;

        const conditions: SQL[] = [];
        if (auth.orgId) {
          conditions.push(
            sql`(${customFieldDefinitions.orgId} = ${auth.orgId} OR ${customFieldDefinitions.orgId} IS NULL)`
          );
        }
        if (auth.partnerId) {
          conditions.push(
            sql`(${customFieldDefinitions.partnerId} = ${auth.partnerId} OR ${customFieldDefinitions.partnerId} IS NULL)`
          );
        }

        const definitions = await db
          .select({
            id: customFieldDefinitions.id,
            name: customFieldDefinitions.name,
            fieldKey: customFieldDefinitions.fieldKey,
            type: customFieldDefinitions.type,
            required: customFieldDefinitions.required,
            options: customFieldDefinitions.options,
            defaultValue: customFieldDefinitions.defaultValue,
          })
          .from(customFieldDefinitions)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(customFieldDefinitions.name);

        return JSON.stringify({
          deviceId,
          hostname: device.hostname,
          customFields: device.customFields ?? {},
          definitions,
        });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  });
}
