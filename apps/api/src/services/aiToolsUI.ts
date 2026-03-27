/**
 * AI UI Tools
 *
 * Tools for managing saved device filters and other UI-related operations.
 * - manage_saved_filters (Tier 1 base): List, create, get, or delete saved device filters
 */

import { db } from '../db';
import { savedFilters } from '../db/schema';
import { eq, and, desc, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

type AiToolTier = 1 | 2 | 3 | 4;

function resolveWritableToolOrgId(
  auth: AuthContext,
  inputOrgId?: string
): { orgId?: string; error?: string } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required' };
    if (inputOrgId && inputOrgId !== auth.orgId) {
      return { error: 'Cannot access another organization' };
    }
    return { orgId: auth.orgId };
  }

  if (inputOrgId) {
    if (!auth.canAccessOrg(inputOrgId)) {
      return { error: 'Access denied to this organization' };
    }
    return { orgId: inputOrgId };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return { orgId: auth.accessibleOrgIds[0] };
  }

  return { error: 'orgId is required for this operation' };
}

export function registerUITools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // manage_saved_filters - Tier 1 base with action escalation
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
    definition: {
      name: 'manage_saved_filters',
      description: 'List, create, or delete saved device filters.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'create', 'delete'],
            description: 'The action to perform',
          },
          filterId: {
            type: 'string',
            description: 'Filter UUID (required for get/delete)',
          },
          name: {
            type: 'string',
            description: 'Filter name (required for create)',
          },
          description: {
            type: 'string',
            description: 'Filter description (optional, for create)',
          },
          conditions: {
            type: 'object',
            description: 'Filter conditions object (required for create)',
          },
        },
        required: ['action'],
      },
    },
    handler: async (input, auth) => {
      const action = input.action as string;

      if (action === 'list') {
        const conditions: SQL[] = [];
        const orgCond = auth.orgCondition(savedFilters.orgId);
        if (orgCond) conditions.push(orgCond);

        const filters = await db
          .select({
            id: savedFilters.id,
            name: savedFilters.name,
            description: savedFilters.description,
            createdAt: savedFilters.createdAt,
          })
          .from(savedFilters)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(savedFilters.createdAt));

        return JSON.stringify({ filters, total: filters.length });
      }

      if (action === 'get') {
        if (!input.filterId) {
          return JSON.stringify({ error: 'filterId is required for get action' });
        }

        const conditions: SQL[] = [eq(savedFilters.id, input.filterId as string)];
        const orgCond = auth.orgCondition(savedFilters.orgId);
        if (orgCond) conditions.push(orgCond);

        const [filter] = await db
          .select()
          .from(savedFilters)
          .where(and(...conditions))
          .limit(1);

        if (!filter) {
          return JSON.stringify({ error: 'Saved filter not found or access denied' });
        }

        return JSON.stringify({ filter });
      }

      if (action === 'create') {
        if (!input.name) {
          return JSON.stringify({ error: 'name is required for create action' });
        }
        if (!input.conditions) {
          return JSON.stringify({ error: 'conditions is required for create action' });
        }

        const resolved = resolveWritableToolOrgId(auth);
        if (resolved.error) return JSON.stringify({ error: resolved.error });

        const [created] = await db
          .insert(savedFilters)
          .values({
            orgId: resolved.orgId!,
            name: input.name as string,
            description: (input.description as string) ?? null,
            conditions: input.conditions as Record<string, unknown>,
            createdBy: auth.user.id,
          })
          .returning({
            id: savedFilters.id,
            name: savedFilters.name,
            createdAt: savedFilters.createdAt,
          });

        return JSON.stringify({ success: true, filter: created });
      }

      if (action === 'delete') {
        if (!input.filterId) {
          return JSON.stringify({ error: 'filterId is required for delete action' });
        }

        const conditions: SQL[] = [eq(savedFilters.id, input.filterId as string)];
        const orgCond = auth.orgCondition(savedFilters.orgId);
        if (orgCond) conditions.push(orgCond);

        const [existing] = await db
          .select({ id: savedFilters.id, name: savedFilters.name })
          .from(savedFilters)
          .where(and(...conditions))
          .limit(1);

        if (!existing) {
          return JSON.stringify({ error: 'Saved filter not found or access denied' });
        }

        await db.delete(savedFilters).where(eq(savedFilters.id, input.filterId as string));

        return JSON.stringify({ success: true, message: `Deleted filter "${existing.name}"` });
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    },
  });
}
