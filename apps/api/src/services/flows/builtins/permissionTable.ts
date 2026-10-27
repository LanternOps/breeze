/**
 * Tool Catalog W05 (#5220), plan Decision 12 — the permission each built-in
 * flow step's effect needs. A leaf (shared types only) so the approver
 * resolver (actionIntents/intentApprovers.ts) can use it without loading the
 * guardrails; rule 7 over it lives in ./permissions.ts. Pinned against the
 * PERMISSIONS constants by permissions.test.ts.
 *
 *  - `notify` ⇒ alerts.write (what `manage_notification_channels`' test send requires);
 *  - `http_request` ⇒ external_tools.write (the tenant Tier-2/3 requirement — the
 *    explicit egress grant; there is no owner-managed origin allowlist);
 *  - `ai` ⇒ ai_sessions.use (what opening a chat session requires), plus each
 *    allowlisted tool's own requirement (./permissions.ts).
 */
import type { FlowBuiltinName } from '@breeze/shared';

export const FLOW_BUILTIN_PERMISSIONS: Readonly<Record<FlowBuiltinName, ReadonlyArray<{ resource: string; action: string }>>> = {
  wait: [],
  set: [],
  notify: [{ resource: 'alerts', action: 'write' }],
  http_request: [{ resource: 'external_tools', action: 'write' }],
  ai: [{ resource: 'ai_sessions', action: 'use' }],
};
