/**
 * AI Integration & Webhook Tools
 *
 * 3 integration-level MCP tools for querying webhooks, PSA connection status,
 * and testing webhook delivery. Each tool wraps existing DB schema with
 * org-scoped isolation.
 */

import { db } from '../db';
import {
  webhooks,
  webhookDeliveries,
  psaConnections,
  psaTicketMappings,
} from '../db/schema/integrations';
import { eq, and, desc, sql, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

type IntegrationHandler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

// ============================================
// Helpers
// ============================================

/** Wrap handler in try-catch so DB/runtime errors return JSON instead of crashing */
function safeHandler(toolName: string, fn: IntegrationHandler): IntegrationHandler {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error(`[integrations:${toolName}]`, message, err);
      return JSON.stringify({ error: 'Operation failed. Check server logs for details.' });
    }
  };
}

// ============================================
// Register all integration tools into the aiTools Map
// ============================================

export function registerIntegrationTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // 1. query_webhooks — List webhooks with delivery status
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'query_webhooks',
      description:
        'List webhooks with their delivery status, success/failure counts, and recent delivery history.',
      input_schema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'disabled', 'error'],
            description: 'Filter by webhook status',
          },
          includeDeliveries: {
            type: 'boolean',
            description:
              'Include last 10 deliveries per webhook (default false)',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 25, max 50)',
          },
        },
        required: [],
      },
    },
    handler: safeHandler('query_webhooks', async (input, auth) => {
      const status = input.status as string | undefined;
      const includeDeliveries = (input.includeDeliveries as boolean) ?? false;
      const limit = Math.min(Math.max((input.limit as number) ?? 25, 1), 50);

      const conditions: SQL[] = [];
      const orgCond = auth.orgCondition(webhooks.orgId);
      if (orgCond) conditions.push(orgCond);
      if (status) conditions.push(eq(webhooks.status, status as 'active' | 'disabled' | 'error'));

      const rows = await db
        .select({
          id: webhooks.id,
          name: webhooks.name,
          url: webhooks.url,
          status: webhooks.status,
          events: webhooks.events,
          successCount: webhooks.successCount,
          failureCount: webhooks.failureCount,
          lastDeliveryAt: webhooks.lastDeliveryAt,
          lastSuccessAt: webhooks.lastSuccessAt,
          createdAt: webhooks.createdAt,
        })
        .from(webhooks)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(webhooks.createdAt))
        .limit(limit);

      if (!includeDeliveries) {
        return JSON.stringify({ webhooks: rows, count: rows.length });
      }

      // Fetch last 10 deliveries per webhook
      const webhooksWithDeliveries = await Promise.all(
        rows.map(async (webhook) => {
          const deliveries = await db
            .select({
              id: webhookDeliveries.id,
              eventType: webhookDeliveries.eventType,
              status: webhookDeliveries.status,
              attempts: webhookDeliveries.attempts,
              responseStatus: webhookDeliveries.responseStatus,
              responseTimeMs: webhookDeliveries.responseTimeMs,
              errorMessage: webhookDeliveries.errorMessage,
              createdAt: webhookDeliveries.createdAt,
              deliveredAt: webhookDeliveries.deliveredAt,
            })
            .from(webhookDeliveries)
            .where(eq(webhookDeliveries.webhookId, webhook.id))
            .orderBy(desc(webhookDeliveries.createdAt))
            .limit(10);

          return { ...webhook, recentDeliveries: deliveries };
        }),
      );

      return JSON.stringify({ webhooks: webhooksWithDeliveries, count: rows.length });
    }),
  });

  // ============================================
  // 2. query_psa_status — PSA connection status and sync history
  // ============================================

  registerTool({
    tier: 1,
    definition: {
      name: 'query_psa_status',
      description:
        'Get PSA connection status, sync history, and ticket mapping summary.',
      input_schema: {
        type: 'object' as const,
        properties: {
          connectionId: {
            type: 'string',
            description: 'Specific PSA connection UUID (optional — omit to list all)',
          },
        },
        required: [],
      },
    },
    handler: safeHandler('query_psa_status', async (input, auth) => {
      const connectionId = input.connectionId as string | undefined;

      const conditions: SQL[] = [];
      const orgCond = auth.orgCondition(psaConnections.orgId);
      if (orgCond) conditions.push(orgCond);
      if (connectionId) conditions.push(eq(psaConnections.id, connectionId));

      const rows = await db
        .select({
          id: psaConnections.id,
          provider: psaConnections.provider,
          name: psaConnections.name,
          enabled: psaConnections.enabled,
          lastSyncAt: psaConnections.lastSyncAt,
          lastSyncStatus: psaConnections.lastSyncStatus,
          lastSyncError: psaConnections.lastSyncError,
          createdAt: psaConnections.createdAt,
        })
        .from(psaConnections)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(psaConnections.createdAt));

      // If a specific connection was requested, also count ticket mappings
      if (connectionId && rows.length > 0) {
        const [ticketCount] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(psaTicketMappings)
          .where(eq(psaTicketMappings.connectionId, rows[0]!.id));

        return JSON.stringify({
          connection: rows[0],
          ticketMappingCount: ticketCount?.count ?? 0,
        });
      }

      return JSON.stringify({ connections: rows, count: rows.length });
    }),
  });

  // ============================================
  // 3. test_webhook — Send a test delivery to verify connectivity
  // ============================================

  registerTool({
    tier: 2,
    definition: {
      name: 'test_webhook',
      description:
        'Send a test delivery to a webhook endpoint to verify connectivity.',
      input_schema: {
        type: 'object' as const,
        properties: {
          webhookId: {
            type: 'string',
            description: 'UUID of the webhook to test',
          },
        },
        required: ['webhookId'],
      },
    },
    handler: safeHandler('test_webhook', async (input, auth) => {
      const webhookId = input.webhookId as string;

      // Verify webhook exists and belongs to org
      const conditions: SQL[] = [eq(webhooks.id, webhookId)];
      const orgCond = auth.orgCondition(webhooks.orgId);
      if (orgCond) conditions.push(orgCond);

      const [webhook] = await db
        .select({ id: webhooks.id, name: webhooks.name, url: webhooks.url })
        .from(webhooks)
        .where(and(...conditions))
        .limit(1);

      if (!webhook) {
        return JSON.stringify({ error: 'Webhook not found or access denied' });
      }

      // Insert a test delivery record
      const now = new Date().toISOString();
      const [delivery] = await db
        .insert(webhookDeliveries)
        .values({
          webhookId: webhook.id,
          eventType: 'test',
          eventId: `test-${Date.now()}`,
          payload: { test: true, timestamp: now },
          status: 'pending',
          attempts: 0,
        })
        .returning({ id: webhookDeliveries.id, createdAt: webhookDeliveries.createdAt });

      if (!delivery) return JSON.stringify({ error: 'Failed to create test delivery record' });

      return JSON.stringify({
        success: true,
        message: `Test delivery queued for webhook "${webhook.name}"`,
        deliveryId: delivery.id,
        webhookId: webhook.id,
        webhookUrl: webhook.url,
        createdAt: delivery.createdAt,
      });
    }),
  });
}
