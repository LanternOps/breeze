/**
 * Script Builder Service
 *
 * Manages script builder AI sessions with script-focused system prompt
 * and curated tool whitelist. Reuses StreamingSessionManager for SDK
 * session lifecycle and SSE streaming.
 */

import { db } from '../db';
import { aiSessions, aiMessages } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { ScriptBuilderContext } from '@breeze/shared/types/ai';
import { buildScriptBuilderSystemPrompt } from './scriptBuilderPrompt';

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
 * Get a script builder session, verifying it belongs to the user's org and is type script_builder.
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
 * The update is org-scoped via auth to enforce tenant isolation.
 */
export async function updateEditorContext(
  sessionId: string,
  context: ScriptBuilderContext,
  auth: AuthContext,
): Promise<string> {
  const systemPrompt = buildScriptBuilderSystemPrompt(context);

  const conditions = [eq(aiSessions.id, sessionId)];
  const orgCondition = auth.orgCondition(aiSessions.orgId);
  if (orgCondition) conditions.push(orgCondition);

  await db
    .update(aiSessions)
    .set({ systemPrompt, contextSnapshot: context })
    .where(and(...conditions));

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
