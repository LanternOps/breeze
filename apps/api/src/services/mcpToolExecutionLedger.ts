import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext } from '../db';
import { aiSessions, aiToolExecutions } from '../db/schema';
import { summarizePayload, summarizeToolResult } from './auditPayloadSanitizer';
import { redactAiToolOutputText } from './aiToolOutput';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface McpToolExecutionLedgerPrincipal {
  apiKeyId: string;
  oauthGrantId?: string | null;
  partnerId?: string | null;
  actorUserId?: string | null;
}

export interface McpToolExecutionLedgerHandle {
  executionId: string;
  sessionId: string;
  orgId: string;
}

export interface BeginMcpToolExecutionLedgerInput {
  orgId: string;
  toolName: string;
  tier: number;
  toolInput: Record<string, unknown>;
  principal: McpToolExecutionLedgerPrincipal;
  transportSessionId?: string | null;
}

export interface CompleteMcpToolExecutionLedgerInput {
  handle: McpToolExecutionLedgerHandle;
  status: 'success' | 'failure';
  durationMs: number;
  result?: string;
  error?: unknown;
}

function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function sanitizePrincipal(principal: McpToolExecutionLedgerPrincipal): Record<string, unknown> {
  return {
    type: 'api_key',
    apiKeyId: principal.apiKeyId.slice(0, 256),
    oauthGrantId: principal.oauthGrantId ?? null,
    partnerId: principal.partnerId ?? null,
    actorUserId: principal.actorUserId ?? null,
  };
}

export async function beginMcpToolExecutionLedger(
  input: BeginMcpToolExecutionLedgerInput,
): Promise<McpToolExecutionLedgerHandle> {
  const sessionId = crypto.randomUUID();
  const principal = sanitizePrincipal(input.principal);
  const target = summarizePayload(input.toolInput, { maxStringLength: 512 });
  const toolInput = {
    source: 'mcp',
    principal,
    orgId: input.orgId,
    toolName: input.toolName,
    tier: input.tier,
    target,
    transport: {
      sessionId: input.transportSessionId ?? null,
    },
  };

  return runOutsideDbContext(() =>
    withDbAccessContext(
      {
        scope: 'organization',
        orgId: input.orgId,
        accessibleOrgIds: [input.orgId],
        userId: isUuid(input.principal.actorUserId) ? input.principal.actorUserId : null,
      },
      async () => {
        await db.insert(aiSessions).values({
          id: sessionId,
          orgId: input.orgId,
          userId: isUuid(input.principal.actorUserId) ? input.principal.actorUserId : null,
          model: 'external-mcp',
          title: `MCP: ${input.toolName}`.slice(0, 255),
          type: 'mcp',
          contextSnapshot: {
            source: 'mcp',
            principal,
            transportSessionId: input.transportSessionId ?? null,
          },
          systemPrompt: null,
        });

        const [execution] = await db
          .insert(aiToolExecutions)
          .values({
            sessionId,
            toolName: input.toolName,
            toolInput,
            status: 'executing',
          })
          .returning({ id: aiToolExecutions.id });

        if (!execution?.id) {
          throw new Error('Failed to create MCP tool execution ledger row');
        }

        return { sessionId, executionId: execution.id, orgId: input.orgId };
      },
    )
  );
}

export async function completeMcpToolExecutionLedger(
  input: CompleteMcpToolExecutionLedgerInput,
): Promise<void> {
  const error = input.error instanceof Error ? input.error : undefined;
  const toolOutput: Record<string, unknown> = {
    source: 'mcp',
    status: input.status,
    durationMs: input.durationMs,
  };

  if (input.result) {
    toolOutput.result = summarizeToolResult(input.result, { maxStringLength: 500 });
  }
  if (error) {
    toolOutput.errorClass = error.name;
  }

  await runOutsideDbContext(() =>
    withDbAccessContext(
      {
        scope: 'organization',
        orgId: input.handle.orgId,
        accessibleOrgIds: [input.handle.orgId],
        userId: null,
      },
      async () => {
        await db
          .update(aiToolExecutions)
          .set({
            status: input.status === 'success' ? 'completed' : 'failed',
            toolOutput,
            errorMessage: error ? redactAiToolOutputText(error.message).slice(0, 1000) : undefined,
            durationMs: input.durationMs,
            completedAt: new Date(),
          })
          .where(eq(aiToolExecutions.id, input.handle.executionId));
      },
    )
  );
}
