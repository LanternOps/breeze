# AI Script Builder Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an inline AI chat assistant to the script editor that auto-applies generated code and metadata, with context-aware tools and test execution capability.

**Architecture:** Dedicated `ScriptBuilderService` wrapping existing Agent SDK/StreamingSessionManager with script-focused system prompt and curated 10-tool whitelist. New `ScriptAiPanel` React component communicates with `ScriptForm` via a callback bridge. Separate Zustand store for state management.

**Tech Stack:** Hono (API routes), Claude Agent SDK, Drizzle ORM, React + Zustand, Monaco Editor, SSE streaming

**Design Doc:** `docs/plans/2026-02-26-ai-script-builder-design.md`

---

## Task 1: Add `type` Column to `aiSessions` Schema

**Files:**
- Modify: `apps/api/src/db/schema/ai.ts:24-51` (aiSessions table definition)

**Step 1: Add the `type` column to the Drizzle schema**

In `apps/api/src/db/schema/ai.ts`, add a `type` field to the `aiSessions` table definition, after the `status` field (line ~30):

```ts
type: text('type').notNull().default('general'),
```

This goes inside the `pgTable('ai_sessions', { ... })` object, after the `status` line.

**Step 2: Push schema change to database**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:push
```

Expected: Drizzle applies the ALTER TABLE adding the `type` column with default `'general'`. All existing sessions get `'general'` automatically.

**Step 3: Verify the column exists**

```bash
docker exec -i breeze-postgres-dev psql -U breeze -d breeze -c "SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name='ai_sessions' AND column_name='type';"
```

Expected: Shows `type | text | 'general'::text`

**Step 4: Commit**

```bash
git add apps/api/src/db/schema/ai.ts
git commit -m "feat(ai): add type column to aiSessions for script_builder sessions"
```

---

## Task 2: Add Shared Types and Validators for Script Builder

**Files:**
- Modify: `packages/shared/src/types/ai.ts` (add new types)
- Modify: `packages/shared/src/validators/ai.ts` (add new validators)

**Step 1: Add types to `packages/shared/src/types/ai.ts`**

Append at the end of the file:

```ts
// ============================================
// Script Builder Types
// ============================================

export type ScriptLanguage = 'powershell' | 'bash' | 'python' | 'cmd';
export type OSType = 'windows' | 'macos' | 'linux';
export type RunAs = 'system' | 'user' | 'elevated';

export interface ScriptBuilderContext {
  scriptId?: string;
  language?: ScriptLanguage;
  osTypes?: OSType[];
  editorSnapshot?: {
    name?: string;
    content?: string;
    description?: string;
    category?: string;
    parameters?: Array<{
      name: string;
      type: 'string' | 'number' | 'boolean' | 'select';
      defaultValue?: string;
      required?: boolean;
      options?: string;
    }>;
    runAs?: RunAs;
    timeoutSeconds?: number;
  };
}

export interface ScriptApplyCode {
  type: 'code';
  code: string;
  language: ScriptLanguage;
}

export interface ScriptApplyMetadata {
  type: 'metadata';
  name?: string;
  description?: string;
  category?: string;
  osTypes?: OSType[];
  parameters?: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'select';
    defaultValue?: string;
    required?: boolean;
    options?: string;
  }>;
  runAs?: RunAs;
  timeoutSeconds?: number;
}

export type ScriptApplyPayload = ScriptApplyCode | ScriptApplyMetadata;
```

**Step 2: Add validators to `packages/shared/src/validators/ai.ts`**

Append at the end of the file:

```ts
// ============================================
// Script Builder Validators
// ============================================

export const scriptBuilderContextSchema = z.object({
  scriptId: z.string().uuid().optional(),
  language: z.enum(['powershell', 'bash', 'python', 'cmd']).optional(),
  osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
  editorSnapshot: z.object({
    name: z.string().optional(),
    content: z.string().optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    parameters: z.array(z.object({
      name: z.string(),
      type: z.enum(['string', 'number', 'boolean', 'select']),
      defaultValue: z.string().optional(),
      required: z.boolean().optional(),
      options: z.string().optional(),
    })).optional(),
    runAs: z.enum(['system', 'user', 'elevated']).optional(),
    timeoutSeconds: z.number().optional(),
  }).optional(),
});

export const createScriptBuilderSessionSchema = z.object({
  context: scriptBuilderContextSchema.optional(),
  title: z.string().max(255).optional(),
});
```

**Step 3: Verify TypeScript compilation**

```bash
cd packages/shared && npx tsc --noEmit
```

Expected: No new errors.

**Step 4: Commit**

```bash
git add packages/shared/src/types/ai.ts packages/shared/src/validators/ai.ts
git commit -m "feat(shared): add script builder types and validators"
```

---

## Task 3: Create Script Builder System Prompt

**Files:**
- Create: `apps/api/src/services/scriptBuilderPrompt.ts`

**Step 1: Create the system prompt builder**

Create `apps/api/src/services/scriptBuilderPrompt.ts`:

```ts
import type { ScriptBuilderContext } from '@breeze/shared/types/ai';

/**
 * Build the system prompt for a script builder AI session.
 * Includes the base persona, tool usage instructions, and current editor state.
 */
export function buildScriptBuilderSystemPrompt(
  context?: ScriptBuilderContext,
): string {
  const base = `You are a script-writing assistant for Breeze RMM, an IT management platform.
You help IT professionals write, improve, and test automation scripts.

You have access to tools that let you:
- Write code directly into the script editor (apply_script_code)
- Set script metadata like name, description, OS targets (apply_script_metadata)
- Look up devices, alerts, and installed software to tailor scripts
- Search the existing script library for reference
- Test-run scripts on devices (requires user approval)

When the user asks you to write or modify a script:
1. Ask clarifying questions if the request is ambiguous
2. Use apply_script_code to write the code into the editor
3. Use apply_script_metadata to fill in appropriate metadata
4. Explain what the script does and any assumptions you made

When editing an existing script, prefer targeted modifications over full rewrites.
Always consider error handling, logging, and cross-platform compatibility.
For PowerShell, prefer modern cmdlets. For Bash, ensure POSIX compatibility where possible.

IMPORTANT: Always use apply_script_code to deliver code to the editor, not just a code block in the chat. The chat message should explain the code; the tool applies it to the editor.`;

  if (!context?.editorSnapshot) {
    return base;
  }

  const snap = context.editorSnapshot;
  const parts = [base, '\n--- Current Editor State ---'];

  if (snap.name) parts.push(`Name: ${snap.name}`);
  if (context.language) parts.push(`Language: ${context.language}`);
  if (context.osTypes?.length) parts.push(`OS Targets: ${context.osTypes.join(', ')}`);
  if (snap.category) parts.push(`Category: ${snap.category}`);
  if (snap.runAs) parts.push(`Run As: ${snap.runAs}`);
  if (snap.timeoutSeconds) parts.push(`Timeout: ${snap.timeoutSeconds}s`);
  if (snap.parameters?.length) {
    parts.push(`Parameters: ${JSON.stringify(snap.parameters)}`);
  }

  parts.push(`\nContent:\n\`\`\`\n${snap.content || '(empty)'}\n\`\`\``);

  return parts.join('\n');
}
```

**Step 2: Verify compilation**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep scriptBuilderPrompt || echo "No errors"
```

**Step 3: Commit**

```bash
git add apps/api/src/services/scriptBuilderPrompt.ts
git commit -m "feat(api): add script builder system prompt builder"
```

---

## Task 4: Create Script Builder MCP Tools

**Files:**
- Create: `apps/api/src/services/scriptBuilderTools.ts`

**Step 1: Create the tool definitions file**

Create `apps/api/src/services/scriptBuilderTools.ts`. This defines the 10 tools (2 apply + 7 context + 1 execution) using the same `tool()` pattern from `@anthropic-ai/claude-agent-sdk`:

```ts
/**
 * Script Builder AI Tool Definitions
 *
 * Curated subset of Breeze AI tools for the script editor assistant.
 * Includes 2 custom apply tools (code + metadata) and 8 existing tools.
 */

import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { AuthContext } from '../middleware/auth';
import { executeTool } from './aiTools';
import { withSystemDbAccessContext } from '../db';
import type { AiToolTier } from '@breeze/shared/types/ai';
import { compactToolResultForChat } from './aiToolOutput';
import type { ActiveSession } from './streamingSessionManager';
import type { PreToolUseCallback, PostToolUseCallback } from './aiAgentSdkTools';

const TOOL_EXECUTION_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool execution timed out after ${ms}ms: ${label}`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ============================================
// Tool Tier Map
// ============================================

export const SCRIPT_BUILDER_TOOL_TIERS: Record<string, AiToolTier> = {
  apply_script_code: 1,
  apply_script_metadata: 1,
  query_devices: 1,
  get_device_details: 1,
  manage_alerts: 1,
  list_scripts: 1,
  get_script_details: 1,
  list_script_templates: 1,
  get_script_execution_history: 1,
  execute_script_on_device: 4,
};

export const SCRIPT_BUILDER_MCP_TOOL_NAMES = Object.keys(SCRIPT_BUILDER_TOOL_TIERS).map(
  name => `mcp__script_builder__${name}`
);

// ============================================
// Handler factory for existing tools
// ============================================

function makeExistingHandler(
  toolName: string,
  getAuth: () => AuthContext,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
) {
  return async (args: Record<string, unknown>) => {
    const startTime = Date.now();

    if (onPreToolUse) {
      let check: { allowed: true } | { allowed: false; error: string };
      try {
        check = await onPreToolUse(toolName, args);
      } catch (err) {
        console.error(`[ScriptBuilder] PreToolUse threw for ${toolName}:`, err);
        check = { allowed: false, error: 'Internal guardrails error.' };
      }
      if (!check.allowed) {
        if (onPostToolUse) {
          try { await onPostToolUse(toolName, args, JSON.stringify({ error: check.error }), true, 0); }
          catch (err) { console.error('[ScriptBuilder] PostToolUse failed:', err); }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: check.error }) }], isError: true };
      }
    }

    try {
      const auth = getAuth();
      const result = await withTimeout(
        withSystemDbAccessContext(() => executeTool(toolName, args, auth)),
        TOOL_EXECUTION_TIMEOUT_MS,
        toolName,
      );
      const compactResult = compactToolResultForChat(toolName, result);
      const durationMs = Date.now() - startTime;

      if (onPostToolUse) {
        try { await onPostToolUse(toolName, args, compactResult, false, durationMs); }
        catch (err) { console.error('[ScriptBuilder] PostToolUse failed:', err); }
      }

      return { content: [{ type: 'text' as const, text: compactResult }] };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      const durationMs = Date.now() - startTime;

      if (onPostToolUse) {
        try { await onPostToolUse(toolName, args, JSON.stringify({ error: errorMsg }), true, durationMs); }
        catch (e) { console.error('[ScriptBuilder] PostToolUse failed:', e); }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: errorMsg }) }], isError: true };
    }
  };
}

// ============================================
// Apply tool handlers (emit SSE events, no DB execution)
// ============================================

function makeApplyHandler(
  toolName: string,
  onPostToolUse?: PostToolUseCallback,
) {
  return async (args: Record<string, unknown>) => {
    const startTime = Date.now();
    // Apply tools succeed immediately — the frontend handles the actual apply.
    // The tool output is serialized JSON that the SSE handler picks up.
    const output = JSON.stringify({ applied: true, toolName, ...args });
    const durationMs = Date.now() - startTime;

    if (onPostToolUse) {
      try { await onPostToolUse(toolName, args, output, false, durationMs); }
      catch (err) { console.error('[ScriptBuilder] PostToolUse failed:', err); }
    }

    return { content: [{ type: 'text' as const, text: output }] };
  };
}

// ============================================
// MCP Server Factory
// ============================================

export function createScriptBuilderMcpServer(
  getAuth: () => AuthContext,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
) {
  const uuid = z.string().uuid();

  const tools = [
    // --- Apply tools (script-builder-only) ---
    tool(
      'apply_script_code',
      'Write or replace the script code in the editor. Use this to deliver code to the user instead of putting it in a chat message.',
      {
        code: z.string().describe('The full script code to write into the editor'),
        language: z.enum(['powershell', 'bash', 'python', 'cmd']).describe('The scripting language'),
      },
      makeApplyHandler('apply_script_code', onPostToolUse)
    ),

    tool(
      'apply_script_metadata',
      'Set script metadata fields in the editor form (name, description, category, OS targets, parameters, etc.). Only include fields you want to change.',
      {
        name: z.string().max(255).optional().describe('Script name'),
        description: z.string().max(2000).optional().describe('Script description'),
        category: z.enum(['Maintenance', 'Security', 'Monitoring', 'Deployment', 'Backup', 'Network', 'User Management', 'Software', 'Custom']).optional(),
        osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
        parameters: z.array(z.object({
          name: z.string(),
          type: z.enum(['string', 'number', 'boolean', 'select']),
          defaultValue: z.string().optional(),
          required: z.boolean().optional(),
          options: z.string().optional(),
        })).optional(),
        runAs: z.enum(['system', 'user', 'elevated']).optional(),
        timeoutSeconds: z.number().int().min(1).max(86400).optional(),
      },
      makeApplyHandler('apply_script_metadata', onPostToolUse)
    ),

    // --- Context tools (reuse existing handlers) ---
    tool(
      'query_devices',
      'Search and filter devices. Use to find devices by OS, status, or name for tailoring scripts.',
      {
        status: z.enum(['online', 'offline', 'maintenance', 'decommissioned']).optional(),
        osType: z.enum(['windows', 'macos', 'linux']).optional(),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      makeExistingHandler('query_devices', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_device_details',
      'Get device details including hardware, OS, network, and installed software.',
      { deviceId: uuid },
      makeExistingHandler('get_device_details', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'manage_alerts',
      'Query alerts for a device or org. Use to understand what issue a script should address.',
      {
        action: z.literal('list'),
        alertId: uuid.optional(),
        status: z.enum(['active', 'acknowledged', 'resolved', 'suppressed']).optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
        deviceId: uuid.optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      makeExistingHandler('manage_alerts', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_scripts',
      'Search the existing script library. Use to find similar scripts or avoid duplicates.',
      {
        search: z.string().max(200).optional(),
        category: z.string().optional(),
        language: z.enum(['powershell', 'bash', 'python', 'cmd']).optional(),
        osType: z.enum(['windows', 'macos', 'linux']).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      makeExistingHandler('list_scripts', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_script_details',
      'Get full details of an existing script including code, parameters, and execution settings.',
      { scriptId: uuid },
      makeExistingHandler('get_script_details', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'list_script_templates',
      'Browse available script templates for common tasks.',
      {
        search: z.string().max(200).optional(),
        category: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      makeExistingHandler('list_script_templates', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'execute_script_on_device',
      'Test-run the current script on a specific device. Requires user approval. The script does not need to be saved first.',
      {
        deviceId: uuid.describe('Target device ID'),
        code: z.string().describe('The script code to execute'),
        language: z.enum(['powershell', 'bash', 'python', 'cmd']),
        runAs: z.enum(['system', 'user', 'elevated']).optional(),
        timeoutSeconds: z.number().int().min(1).max(86400).optional(),
      },
      makeExistingHandler('run_script', getAuth, onPreToolUse, onPostToolUse)
    ),
  ];

  return createSdkMcpServer({ name: 'script_builder', tools });
}
```

**Step 2: Verify compilation**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep scriptBuilder || echo "No errors"
```

**Step 3: Commit**

```bash
git add apps/api/src/services/scriptBuilderTools.ts
git commit -m "feat(api): add script builder MCP tool definitions"
```

---

## Task 5: Create Script Builder Service

**Files:**
- Create: `apps/api/src/services/scriptBuilderService.ts`

**Step 1: Create the service**

This service wraps `StreamingSessionManager` with script-builder-specific configuration. Create `apps/api/src/services/scriptBuilderService.ts`:

```ts
/**
 * Script Builder Service
 *
 * Manages script builder AI sessions with script-focused system prompt
 * and curated tool whitelist. Reuses StreamingSessionManager for SDK
 * session lifecycle and SSE streaming.
 */

import { db } from '../db';
import { aiSessions, aiMessages } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { ScriptBuilderContext } from '@breeze/shared/types/ai';
import { buildScriptBuilderSystemPrompt } from './scriptBuilderPrompt';
import { SCRIPT_BUILDER_MCP_TOOL_NAMES } from './scriptBuilderTools';

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * Create a script builder session in the database.
 */
export async function createScriptBuilderSession(
  auth: AuthContext,
  options: { context?: ScriptBuilderContext; title?: string },
): Promise<{ id: string; orgId: string }> {
  const orgId = auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null;
  if (!orgId) throw new Error('Organization context required');

  const systemPrompt = buildScriptBuilderSystemPrompt(options.context);

  const [session] = await db
    .insert(aiSessions)
    .values({
      orgId,
      userId: auth.user.id,
      model: DEFAULT_MODEL,
      title: options.title ?? 'Script Builder',
      contextSnapshot: options.context ?? null,
      systemPrompt,
      type: 'script_builder',
    })
    .returning();

  if (!session) throw new Error('Failed to create session');
  return { id: session.id, orgId };
}

/**
 * Get a script builder session, verifying it belongs to the user and is type script_builder.
 */
export async function getScriptBuilderSession(sessionId: string, auth: AuthContext) {
  const conditions = [
    eq(aiSessions.id, sessionId),
    eq(aiSessions.type, 'script_builder'),
  ];
  const orgCondition = auth.orgCondition(aiSessions.orgId);
  if (orgCondition) conditions.push(orgCondition);

  const [session] = await db
    .select()
    .from(aiSessions)
    .where(and(...conditions))
    .limit(1);

  return session ?? null;
}

/**
 * Get messages for a script builder session.
 */
export async function getScriptBuilderMessages(sessionId: string) {
  return db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.sessionId, sessionId))
    .orderBy(aiMessages.createdAt);
}

/**
 * Update the system prompt with the latest editor state.
 * Called on each message to keep the AI aware of manual edits.
 */
export async function updateEditorContext(
  sessionId: string,
  context: ScriptBuilderContext,
): Promise<string> {
  const systemPrompt = buildScriptBuilderSystemPrompt(context);

  await db
    .update(aiSessions)
    .set({ systemPrompt, contextSnapshot: context })
    .where(eq(aiSessions.id, sessionId));

  return systemPrompt;
}

/**
 * Close a script builder session.
 */
export async function closeScriptBuilderSession(sessionId: string, auth: AuthContext) {
  const session = await getScriptBuilderSession(sessionId, auth);
  if (!session) throw new Error('Session not found');

  await db
    .update(aiSessions)
    .set({ status: 'closed' })
    .where(eq(aiSessions.id, sessionId));
}
```

**Step 2: Verify compilation**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep scriptBuilder || echo "No errors"
```

**Step 3: Commit**

```bash
git add apps/api/src/services/scriptBuilderService.ts
git commit -m "feat(api): add script builder session service"
```

---

## Task 6: Create Script Builder API Routes

**Files:**
- Create: `apps/api/src/routes/scriptAi.ts`
- Modify: `apps/api/src/index.ts:632` (mount new routes)

**Step 1: Create the route file**

Create `apps/api/src/routes/scriptAi.ts`:

```ts
/**
 * Script Builder AI Routes
 *
 * REST + SSE endpoints for the inline script editor AI assistant.
 * Mounted at /api/v1/ai/script-builder
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { streamSSE } from 'hono/streaming';
import { authMiddleware, requireScope } from '../middleware/auth';
import {
  createScriptBuilderSession,
  getScriptBuilderSession,
  getScriptBuilderMessages,
  updateEditorContext,
  closeScriptBuilderSession,
} from '../services/scriptBuilderService';
import { runPreFlightChecks, abortActivePlan } from '../services/aiAgentSdk';
import { streamingSessionManager } from '../services/streamingSessionManager';
import { writeRouteAudit } from '../services/auditEvents';
import {
  createScriptBuilderSessionSchema,
  sendAiMessageSchema,
  approveToolSchema,
  scriptBuilderContextSchema,
} from '@breeze/shared/validators/ai';
import { SCRIPT_BUILDER_MCP_TOOL_NAMES } from '../services/scriptBuilderTools';
import { captureException } from '../services/sentry';

export const scriptAiRoutes = new Hono();

scriptAiRoutes.use('*', authMiddleware);

// ============================================
// Session CRUD
// ============================================

// POST /sessions — Create a new script builder session
scriptAiRoutes.post(
  '/sessions',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createScriptBuilderSessionSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    try {
      const session = await createScriptBuilderSession(auth, body);
      writeRouteAudit(c, {
        orgId: session.orgId,
        action: 'ai.script_builder.session.create',
        resourceType: 'ai_session',
        resourceId: session.id,
        resourceName: body.title ?? 'Script Builder',
      });
      return c.json(session, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create session';
      if (message === 'Organization context required') return c.json({ error: message }, 400);
      return c.json({ error: message }, 500);
    }
  }
);

// GET /sessions/:id — Get session with messages
scriptAiRoutes.get(
  '/sessions/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const session = await getScriptBuilderSession(c.req.param('id'), auth);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    const messages = await getScriptBuilderMessages(session.id);
    return c.json({ session, messages });
  }
);

// DELETE /sessions/:id — Close session
scriptAiRoutes.delete(
  '/sessions/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    try {
      await closeScriptBuilderSession(c.req.param('id'), auth);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to close session';
      return c.json({ error: message }, 404);
    }
  }
);

// ============================================
// Messaging (SSE streaming)
// ============================================

// POST /sessions/:id/messages — Send message, returns SSE stream
scriptAiRoutes.post(
  '/sessions/:id/messages',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', sendAiMessageSchema.extend({
    editorContext: scriptBuilderContextSchema.optional(),
  })),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');
    const { content, editorContext } = c.req.valid('json');

    // Update system prompt with latest editor state if provided
    let systemPrompt: string | undefined;
    if (editorContext) {
      try {
        systemPrompt = await updateEditorContext(sessionId, editorContext);
      } catch (err) {
        console.error('[ScriptAI] Failed to update editor context:', err);
      }
    }

    // Run pre-flight checks (rate limits, budget, session status)
    const preflight = await runPreFlightChecks(sessionId, content, auth, undefined, c);
    if (!preflight.ok) {
      return c.json({ error: preflight.error }, 400);
    }

    // Use updated system prompt if we refreshed editor context
    const effectiveSystemPrompt = systemPrompt ?? preflight.systemPrompt;

    return streamSSE(c, async (stream) => {
      try {
        const session = await streamingSessionManager.getOrCreate(
          sessionId,
          {
            orgId: preflight.session.orgId,
            sdkSessionId: preflight.session.sdkSessionId,
            model: preflight.session.model,
            maxTurns: preflight.session.maxTurns,
            turnCount: preflight.session.turnCount,
            systemPrompt: preflight.session.systemPrompt,
          },
          auth,
          c,
          effectiveSystemPrompt,
          preflight.maxBudgetUsd,
          SCRIPT_BUILDER_MCP_TOOL_NAMES,
        );

        if (!streamingSessionManager.tryTransitionToProcessing(session)) {
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'Session is busy processing another message' }) });
          return;
        }

        // Push user message
        session.inputController.pushMessage(content);

        // Stream events from the session event bus
        const eventIterator = session.eventBus.subscribe();
        for await (const event of eventIterator) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });

          if (event.type === 'done' || event.type === 'error') break;
        }
      } catch (err) {
        captureException(err);
        console.error('[ScriptAI] Streaming error:', err);
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: 'Internal streaming error' }),
        });
      }
    });
  }
);

// POST /sessions/:id/interrupt — Interrupt active response
scriptAiRoutes.post(
  '/sessions/:id/interrupt',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const sessionId = c.req.param('id');
    const session = streamingSessionManager.get(sessionId);
    if (!session) return c.json({ error: 'No active session' }, 404);

    session.abortController.abort();
    return c.json({ ok: true });
  }
);

// ============================================
// Tool Approval (for execute_script_on_device)
// ============================================

// POST /sessions/:id/approve/:executionId
scriptAiRoutes.post(
  '/sessions/:id/approve/:executionId',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', approveToolSchema),
  async (c) => {
    const auth = c.get('auth');
    const sessionId = c.req.param('id');
    const executionId = c.req.param('executionId');
    const { approved } = c.req.valid('json');

    try {
      const { handleApproval } = await import('../services/aiAgent');
      const result = await handleApproval(sessionId, executionId, approved, auth);
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to process approval';
      return c.json({ error: message }, 400);
    }
  }
);
```

**Step 2: Mount routes in `apps/api/src/index.ts`**

After line 632 (`api.route('/ai', aiRoutes);`), add:

```ts
import { scriptAiRoutes } from './routes/scriptAi';
```

Add the import with the other imports at the top, then add the route mount:

```ts
api.route('/ai/script-builder', scriptAiRoutes);
```

Place this line right after the existing `api.route('/ai', aiRoutes);` line (line 632).

**Step 3: Verify compilation**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | head -20
```

Expected: No new errors related to scriptAi.

**Step 4: Commit**

```bash
git add apps/api/src/routes/scriptAi.ts apps/api/src/index.ts
git commit -m "feat(api): add script builder API routes with SSE streaming"
```

---

## Task 7: Create Script AI Zustand Store

**Files:**
- Create: `apps/web/src/stores/scriptAiStore.ts`

**Step 1: Create the store**

Create `apps/web/src/stores/scriptAiStore.ts`:

```ts
import { create } from 'zustand';
import { fetchWithAuth } from './auth';

export interface ScriptAiMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  isStreaming?: boolean;
  createdAt: Date;
}

interface PendingApproval {
  executionId: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
}

export interface ScriptFormValues {
  name: string;
  description?: string;
  category: string;
  language: 'powershell' | 'bash' | 'python' | 'cmd';
  osTypes: ('windows' | 'macos' | 'linux')[];
  content: string;
  parameters?: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'select';
    defaultValue?: string;
    required?: boolean;
    options?: string;
  }>;
  timeoutSeconds: number;
  runAs: 'system' | 'user' | 'elevated';
}

export interface ScriptFormBridge {
  getFormValues: () => ScriptFormValues;
  setFormValues: (partial: Partial<ScriptFormValues>) => void;
  takeSnapshot: () => void;
  restoreSnapshot: () => void;
}

interface ScriptAiState {
  sessionId: string | null;
  messages: ScriptAiMessage[];
  isStreaming: boolean;
  isLoading: boolean;
  error: string | null;
  pendingApproval: PendingApproval | null;
  panelOpen: boolean;
  hasApplied: boolean; // true after AI applied something (enables revert)

  // Bridge to ScriptForm (set by component on mount)
  _bridge: ScriptFormBridge | null;
  setBridge: (bridge: ScriptFormBridge | null) => void;

  // Actions
  togglePanel: () => void;
  openPanel: () => void;
  closePanel: () => void;
  createSession: (context?: Record<string, unknown>) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  approveExecution: (executionId: string, approved: boolean) => Promise<void>;
  interruptResponse: () => Promise<void>;
  closeSession: () => Promise<void>;
  revert: () => void;
  clearError: () => void;
}

export const useScriptAiStore = create<ScriptAiState>((set, get) => ({
  sessionId: null,
  messages: [],
  isStreaming: false,
  isLoading: false,
  error: null,
  pendingApproval: null,
  panelOpen: false,
  hasApplied: false,
  _bridge: null,

  setBridge: (bridge) => set({ _bridge: bridge }),

  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),

  clearError: () => set({ error: null }),

  revert: () => {
    const { _bridge } = get();
    if (_bridge) {
      _bridge.restoreSnapshot();
      set({ hasApplied: false });
    }
  },

  createSession: async (context) => {
    set({ isLoading: true, error: null });
    try {
      const res = await fetchWithAuth('/api/v1/ai/script-builder/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create session');
      }
      const { id } = await res.json();
      set({ sessionId: id, messages: [], isLoading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Unknown error', isLoading: false });
    }
  },

  sendMessage: async (content) => {
    const { sessionId, _bridge } = get();
    if (!sessionId) return;

    // Add user message
    const userMsg: ScriptAiMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      createdAt: new Date(),
    };

    // Build editor context for system prompt refresh
    const editorContext = _bridge ? {
      editorSnapshot: _bridge.getFormValues(),
      language: _bridge.getFormValues().language,
      osTypes: _bridge.getFormValues().osTypes,
    } : undefined;

    set((s) => ({
      messages: [...s.messages, userMsg],
      isStreaming: true,
      error: null,
    }));

    // Placeholder assistant message for streaming
    const assistantMsg: ScriptAiMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
      isStreaming: true,
      createdAt: new Date(),
    };
    set((s) => ({ messages: [...s.messages, assistantMsg] }));

    let snapshotTaken = false;

    try {
      const res = await fetchWithAuth(`/api/v1/ai/script-builder/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, editorContext }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to send message');
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No response body');

      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              const eventType = event.type;

              if (eventType === 'content_delta') {
                set((s) => ({
                  messages: s.messages.map((m) =>
                    m.id === assistantMsg.id
                      ? { ...m, content: m.content + (event.delta || '') }
                      : m
                  ),
                }));
              } else if (eventType === 'tool_result') {
                // Check for apply tool results
                if (event.toolName === 'apply_script_code' || event.toolName === 'apply_script_metadata') {
                  const bridge = get()._bridge;
                  if (bridge) {
                    if (!snapshotTaken) {
                      bridge.takeSnapshot();
                      snapshotTaken = true;
                    }

                    try {
                      const output = typeof event.output === 'string' ? JSON.parse(event.output) : event.output;
                      if (event.toolName === 'apply_script_code') {
                        bridge.setFormValues({
                          content: output.code,
                          language: output.language,
                        });
                      } else {
                        const { applied, toolName, ...metadata } = output;
                        bridge.setFormValues(metadata);
                      }
                      set({ hasApplied: true });
                    } catch (err) {
                      console.error('[ScriptAI] Failed to parse apply output:', err);
                    }
                  }
                }

                // Add tool result message
                set((s) => ({
                  messages: [...s.messages, {
                    id: `tool-${Date.now()}`,
                    role: 'tool_result' as const,
                    content: typeof event.output === 'string' ? event.output : JSON.stringify(event.output),
                    toolName: event.toolName,
                    createdAt: new Date(),
                  }],
                }));
              } else if (eventType === 'tool_use_start') {
                set((s) => ({
                  messages: [...s.messages, {
                    id: `tool_use-${Date.now()}`,
                    role: 'tool_use' as const,
                    content: '',
                    toolName: event.toolName,
                    toolInput: event.input,
                    createdAt: new Date(),
                  }],
                }));
              } else if (eventType === 'approval_required') {
                set({
                  pendingApproval: {
                    executionId: event.executionId,
                    toolName: event.toolName,
                    input: event.input,
                    description: event.description || `Execute ${event.toolName}`,
                  },
                });
              } else if (eventType === 'done' || eventType === 'error') {
                if (eventType === 'error') {
                  set({ error: event.error || 'Unknown streaming error' });
                }
                break;
              }
            } catch {
              // Skip malformed SSE lines
            }
          }
        }
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      // Mark assistant message as done
      set((s) => ({
        isStreaming: false,
        messages: s.messages.map((m) =>
          m.id === assistantMsg.id ? { ...m, isStreaming: false } : m
        ),
      }));
    }
  },

  approveExecution: async (executionId, approved) => {
    const { sessionId } = get();
    if (!sessionId) return;

    try {
      await fetchWithAuth(`/api/v1/ai/script-builder/sessions/${sessionId}/approve/${executionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved }),
      });
      set({ pendingApproval: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Approval failed' });
    }
  },

  interruptResponse: async () => {
    const { sessionId } = get();
    if (!sessionId) return;

    try {
      await fetchWithAuth(`/api/v1/ai/script-builder/sessions/${sessionId}/interrupt`, {
        method: 'POST',
      });
    } catch (err) {
      console.error('[ScriptAI] Interrupt failed:', err);
    }
  },

  closeSession: async () => {
    const { sessionId } = get();
    if (!sessionId) return;

    try {
      await fetchWithAuth(`/api/v1/ai/script-builder/sessions/${sessionId}`, {
        method: 'DELETE',
      });
    } catch {
      // Best-effort cleanup
    }
    set({ sessionId: null, messages: [], hasApplied: false, pendingApproval: null });
  },
}));
```

**Step 2: Verify TypeScript compilation**

```bash
cd apps/web && npx tsc --noEmit 2>&1 | head -20
```

**Step 3: Commit**

```bash
git add apps/web/src/stores/scriptAiStore.ts
git commit -m "feat(web): add script AI Zustand store with SSE streaming"
```

---

## Task 8: Create ScriptAiInput Component

**Files:**
- Create: `apps/web/src/components/scripts/ScriptAiInput.tsx`

**Step 1: Create the input component**

Create `apps/web/src/components/scripts/ScriptAiInput.tsx`:

```tsx
import { useState, useCallback, useRef, useEffect } from 'react';
import { Send, Square } from 'lucide-react';
import { useScriptAiStore } from '@/stores/scriptAiStore';

export default function ScriptAiInput() {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { sendMessage, isStreaming, interruptResponse, sessionId } = useScriptAiStore();

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [input]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;
    setInput('');
    await sendMessage(trimmed);
  }, [input, isStreaming, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div className="border-t bg-background p-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={sessionId ? 'Describe the script you need...' : 'Opening AI assistant...'}
          disabled={!sessionId}
          rows={1}
          className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        />
        {isStreaming ? (
          <button
            onClick={interruptResponse}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-destructive/10 text-destructive hover:bg-destructive/20"
            title="Stop generating"
          >
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!input.trim() || !sessionId}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            title="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/web/src/components/scripts/ScriptAiInput.tsx
git commit -m "feat(web): add ScriptAiInput component"
```

---

## Task 9: Create ScriptAiMessages Component

**Files:**
- Create: `apps/web/src/components/scripts/ScriptAiMessages.tsx`

**Step 1: Create the messages component**

Create `apps/web/src/components/scripts/ScriptAiMessages.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { Bot, User, Wrench, Check, X, Loader2 } from 'lucide-react';
import { useScriptAiStore, type ScriptAiMessage } from '@/stores/scriptAiStore';

function MessageBubble({ message }: { message: ScriptAiMessage }) {
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool_use' || message.role === 'tool_result';

  if (isTool) {
    const isApplyTool = message.toolName?.startsWith('apply_script_');
    return (
      <div className="mx-3 my-1 flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
        <Wrench className="h-3 w-3 shrink-0" />
        <span className="truncate">
          {isApplyTool && message.role === 'tool_result'
            ? `Applied to editor`
            : message.toolName ?? 'Tool call'}
        </span>
        {message.role === 'tool_result' && (
          <Check className="h-3 w-3 shrink-0 text-green-500" />
        )}
      </div>
    );
  }

  return (
    <div className={`flex gap-2 px-3 py-2 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
        isUser ? 'bg-primary text-primary-foreground' : 'bg-muted'
      }`}>
        {isUser ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
      </div>
      <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
        isUser
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted'
      }`}>
        <div className="whitespace-pre-wrap break-words">
          {message.content}
          {message.isStreaming && (
            <span className="ml-1 inline-block h-3 w-1 animate-pulse bg-current" />
          )}
        </div>
      </div>
    </div>
  );
}

function ApprovalCard() {
  const { pendingApproval, approveExecution } = useScriptAiStore();
  if (!pendingApproval) return null;

  return (
    <div className="mx-3 my-2 rounded-lg border border-amber-500/50 bg-amber-50 p-3 dark:bg-amber-950/30">
      <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
        Approval Required
      </p>
      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
        {pendingApproval.description}
      </p>
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => approveExecution(pendingApproval.executionId, true)}
          className="flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
        >
          <Check className="h-3 w-3" /> Approve
        </button>
        <button
          onClick={() => approveExecution(pendingApproval.executionId, false)}
          className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          <X className="h-3 w-3" /> Reject
        </button>
      </div>
    </div>
  );
}

export default function ScriptAiMessages() {
  const { messages, isStreaming, isLoading } = useScriptAiStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
        <Bot className="h-8 w-8 text-muted-foreground/50" />
        <p className="mt-2 text-sm font-medium text-muted-foreground">Script AI Assistant</p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          Describe what you need and I'll write the script for you.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      <ApprovalCard />
      <div ref={bottomRef} />
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/web/src/components/scripts/ScriptAiMessages.tsx
git commit -m "feat(web): add ScriptAiMessages component with approval card"
```

---

## Task 10: Create ScriptAiPanel Component

**Files:**
- Create: `apps/web/src/components/scripts/ScriptAiPanel.tsx`

**Step 1: Create the panel component**

Create `apps/web/src/components/scripts/ScriptAiPanel.tsx`:

```tsx
import { useEffect } from 'react';
import { X, Undo2 } from 'lucide-react';
import { useScriptAiStore } from '@/stores/scriptAiStore';
import ScriptAiMessages from './ScriptAiMessages';
import ScriptAiInput from './ScriptAiInput';
import type { ScriptFormBridge } from '@/stores/scriptAiStore';

interface ScriptAiPanelProps {
  bridge: ScriptFormBridge;
}

export default function ScriptAiPanel({ bridge }: ScriptAiPanelProps) {
  const {
    panelOpen,
    closePanel,
    sessionId,
    createSession,
    closeSession,
    setBridge,
    hasApplied,
    revert,
    error,
    clearError,
  } = useScriptAiStore();

  // Register the form bridge
  useEffect(() => {
    setBridge(bridge);
    return () => setBridge(null);
  }, [bridge, setBridge]);

  // Create session when panel opens for the first time
  useEffect(() => {
    if (panelOpen && !sessionId) {
      const formValues = bridge.getFormValues();
      createSession({
        language: formValues.language,
        osTypes: formValues.osTypes,
        editorSnapshot: formValues,
      });
    }
  }, [panelOpen, sessionId, createSession, bridge]);

  // Cleanup session on unmount
  useEffect(() => {
    return () => {
      closeSession();
    };
  }, [closeSession]);

  if (!panelOpen) return null;

  return (
    <div className="flex w-96 shrink-0 flex-col border-l bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">AI Script Assistant</span>
        <div className="flex items-center gap-1">
          {hasApplied && (
            <button
              onClick={revert}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
              title="Revert last AI change"
            >
              <Undo2 className="h-3 w-3" />
              Revert
            </button>
          )}
          <button
            onClick={closePanel}
            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="border-b bg-destructive/10 px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs text-destructive">{error}</p>
            <button onClick={clearError} className="text-xs text-destructive hover:underline">
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Messages */}
      <ScriptAiMessages />

      {/* Input */}
      <ScriptAiInput />
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/web/src/components/scripts/ScriptAiPanel.tsx
git commit -m "feat(web): add ScriptAiPanel component"
```

---

## Task 11: Integrate ScriptAiPanel into ScriptForm

**Files:**
- Modify: `apps/web/src/components/scripts/ScriptForm.tsx`

**Step 1: Add AI panel imports and state**

At the top of `ScriptForm.tsx`, add imports:

```ts
import { useCallback, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { useScriptAiStore } from '@/stores/scriptAiStore';
import type { ScriptFormBridge } from '@/stores/scriptAiStore';

const ScriptAiPanel = lazy(() => import('./ScriptAiPanel'));
```

Note: `useMemo` and `useState` are already imported. Add `useCallback` and `useRef` to the existing import from `react`. `lazy` and `Suspense` are already imported.

**Step 2: Add bridge and snapshot logic inside the component**

Inside the `ScriptForm` component function, after the `useForm` and `useFieldArray` calls, add:

```ts
const { panelOpen, togglePanel } = useScriptAiStore();

// Snapshot for revert
const snapshotRef = useRef<ScriptFormValues | null>(null);

const bridge: ScriptFormBridge = useMemo(() => ({
  getFormValues: () => watch() as ScriptFormValues,
  setFormValues: (partial) => {
    Object.entries(partial).forEach(([key, value]) => {
      if (value !== undefined) {
        setValue(key as keyof ScriptFormValues, value as never, { shouldDirty: true });
      }
    });
  },
  takeSnapshot: () => {
    snapshotRef.current = structuredClone(watch() as ScriptFormValues);
  },
  restoreSnapshot: () => {
    if (snapshotRef.current) {
      Object.entries(snapshotRef.current).forEach(([key, value]) => {
        setValue(key as keyof ScriptFormValues, value as never, { shouldDirty: true });
      });
      snapshotRef.current = null;
    }
  },
}), [watch, setValue]);
```

**Step 3: Add keyboard shortcut**

After the bridge definition, add:

```ts
// Keyboard shortcut: Cmd+Shift+I to toggle AI panel
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'i') {
      e.preventDefault();
      togglePanel();
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, [togglePanel]);
```

Note: `useEffect` needs to be added to the existing React import.

**Step 4: Modify the Script Content section layout**

Replace the `{/* Script Content */}` section (the `<div className="space-y-2">` wrapping the Monaco editor) with a flex layout that includes the AI panel:

```tsx
{/* Script Content + AI Panel */}
<div className="space-y-2">
  <div className="flex items-center justify-between">
    <label className="text-sm font-medium">Script Content</label>
    <button
      type="button"
      onClick={togglePanel}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition',
        panelOpen
          ? 'bg-primary text-primary-foreground'
          : 'border hover:bg-muted'
      )}
      title="Toggle AI Script Assistant (⌘⇧I)"
    >
      <Sparkles className="h-3.5 w-3.5" />
      AI Assistant
    </button>
  </div>
  <div className="flex rounded-md border overflow-hidden">
    <div className="flex-1">
      <Controller
        name="content"
        control={control}
        render={({ field }) => (
          <Suspense fallback={
            <div className="flex items-center justify-center h-[400px] bg-[#1e1e1e]">
              <div className="text-center text-white/60">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/40 border-t-white mx-auto" />
                <p className="mt-2 text-sm">Loading editor...</p>
              </div>
            </div>
          }>
            <Editor
              height="400px"
              language={monacoLanguage}
              value={field.value}
              onChange={(value) => field.onChange(value || '')}
              onMount={() => setEditorMounted(true)}
              theme="vs-dark"
              options={{
                minimap: { enabled: false },
                fontSize: 14,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                automaticLayout: true,
                tabSize: 2,
                padding: { top: 12, bottom: 12 }
              }}
            />
          </Suspense>
        )}
      />
    </div>
    <Suspense fallback={null}>
      <ScriptAiPanel bridge={bridge} />
    </Suspense>
  </div>
  {errors.content && <p className="text-sm text-destructive">{errors.content.message}</p>}
</div>
```

**Step 5: Verify the page renders**

Start the dev server and navigate to the script editor page:

```bash
pnpm dev
```

Open browser to the script editor (create new script page). Verify:
- The "AI Assistant" button with sparkles icon appears above the editor
- Clicking it opens the AI panel to the right of the Monaco editor
- Clicking again closes it
- `Cmd+Shift+I` toggles the panel

**Step 6: Commit**

```bash
git add apps/web/src/components/scripts/ScriptForm.tsx
git commit -m "feat(web): integrate ScriptAiPanel into ScriptForm with toggle and revert"
```

---

## Task 12: End-to-End Integration Testing

**Step 1: Start the dev environment**

```bash
pnpm dev
```

**Step 2: Manual test — create a script with AI**

1. Navigate to Scripts > New Script
2. Click "AI Assistant" button
3. Type: "Write a PowerShell script that gets disk usage for all drives and alerts if any are over 90% full"
4. Verify:
   - Session is created (no console errors)
   - AI streams a response
   - Code appears in Monaco editor automatically
   - Metadata fields (name, language, OS, category) are filled in
   - "Revert" button appears in the AI panel header

**Step 3: Test revert**

1. Click "Revert" in the AI panel
2. Verify: Editor and metadata fields return to their previous state

**Step 4: Test context-awareness**

1. Type: "Now modify it to also check RAM usage"
2. Verify: AI reads the existing editor content and produces an updated script

**Step 5: Test session cleanup**

1. Navigate away from the script editor
2. Check browser console — no errors about orphaned sessions

**Step 6: Commit any fixes discovered during testing**

```bash
git add -A
git commit -m "fix: integration fixes from e2e testing"
```

---

## Task 13: Add `list_scripts` and Related Tool Handlers

**Note:** The existing `executeTool()` in `aiTools.ts` may not have handlers for `list_scripts`, `get_script_details`, `list_script_templates`, or `get_script_execution_history` by those exact names. If they don't exist, they need to be added.

**Step 1: Check which tool names are already handled**

```bash
grep -n "case 'list_scripts\|case 'get_script_details\|case 'list_script_templates\|case 'get_script_execution_history" apps/api/src/services/aiTools.ts
```

**Step 2: If any are missing, add handlers to `aiTools.ts`**

For each missing tool, add a `case` block inside the `executeTool` switch that queries the existing scripts tables. The handlers should:

- `list_scripts`: Query `scripts` table filtered by org, with optional search/category/language/osType filters. Return array of `{ id, name, language, osTypes, category, description }`.
- `get_script_details`: Query single script by ID with org check. Return full script including content, parameters, timeout, runAs.
- `list_script_templates`: Query `scriptTemplates` table with optional filters.
- `get_script_execution_history`: Query `scriptExecutions` + `scriptExecutionBatches` for a given scriptId. Return recent executions with status, exit code, device info.

Follow the existing pattern of other `case` handlers in `aiTools.ts`.

**Step 3: Verify and commit**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | head -20
git add apps/api/src/services/aiTools.ts
git commit -m "feat(api): add script library tool handlers for AI script builder"
```

---

## Summary

| Task | What | Key Files |
|------|------|-----------|
| 1 | DB schema: add `type` to `aiSessions` | `db/schema/ai.ts` |
| 2 | Shared types + validators | `packages/shared/src/types/ai.ts`, `validators/ai.ts` |
| 3 | System prompt builder | `services/scriptBuilderPrompt.ts` |
| 4 | MCP tool definitions (10 tools) | `services/scriptBuilderTools.ts` |
| 5 | Script builder service (session CRUD) | `services/scriptBuilderService.ts` |
| 6 | API routes + mount | `routes/scriptAi.ts`, `index.ts` |
| 7 | Zustand store with SSE streaming | `stores/scriptAiStore.ts` |
| 8 | Chat input component | `components/scripts/ScriptAiInput.tsx` |
| 9 | Chat messages component | `components/scripts/ScriptAiMessages.tsx` |
| 10 | AI panel wrapper | `components/scripts/ScriptAiPanel.tsx` |
| 11 | Integrate panel into ScriptForm | `components/scripts/ScriptForm.tsx` |
| 12 | End-to-end integration test | Manual testing |
| 13 | Script library tool handlers | `services/aiTools.ts` |
