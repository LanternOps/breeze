/**
 * DB phases of a self-managed AI tool handler (#7128, #7918).
 *
 * A tool that declares `selfManagedDbContext` (see `AiTool` in aiTools.ts)
 * reaches its handler with NO DB access context: the chat/agent SDK wrapper,
 * the MCP route and the intent-release worker all skip the per-call
 * transaction for it, so the handler can wait on a device (or another process)
 * without pinning a pooled connection idle-in-transaction. Production Postgres
 * kills such a session after one minute, which is how `run_script` lost every
 * script that ran longer than that (#7918).
 *
 * The handler's own reads and writes still need the caller's tenant context —
 * without one they run on the bare pool as `breeze_app`, where RLS returns no
 * rows (a silent "Device not found") and a write trips the contextless-write
 * guard. Each such phase goes through this helper:
 *
 *  - no context held (the self-managed path): a SHORT context built from
 *    `auth` by the canonical `dbAccessContextFromAuth` — the same builder the
 *    SDK wrapper and `executeTool` use, so RLS sees exactly the caller's scope
 *    and the transaction commits before the handler goes on to wait;
 *  - a context already held (a caller that still wraps the call, e.g. a test
 *    or any surface that does not consult the flag): JOIN it unchanged. That
 *    caller already owns the connection; nesting would only take a second one.
 *
 * Never use it around the wait itself. A wait inside it would hold the very
 * transaction this exists to release.
 */
import { hasDbAccessContext, withDbAccessContext } from '../db';
import { dbAccessContextFromAuth, type AuthContext } from '../middleware/auth';

export function inToolDbPhase<T>(auth: AuthContext, fn: () => Promise<T>): Promise<T> {
  return hasDbAccessContext() ? fn() : withDbAccessContext(dbAccessContextFromAuth(auth), fn);
}
