import { formatToolName } from '@/lib/utils';

/** Structural, so any `t` fits; keys carry the `settings:` namespace explicitly (same shape agentErrors.ts uses). */
export type CatalogTranslateFn = (key: string, options?: Record<string, unknown>) => string;

/**
 * The one place the agent builder turns a catalog tool / operation /
 * capability id into display copy (#10194). CapabilityPicker and
 * AgentSummaryCard both render these labels; each used to carry its own copy
 * of the lookup and the fallback.
 *
 * Copy lives in `settings:aiAgentsPage.catalog.{tools,actions,capabilities}`.
 * `apps/api/src/services/aiAgents/agentToolCatalog.labels.contract.test.ts`
 * fails when the server catalog serves a tool, operation or capability with
 * no English label, so the humanized fallback below is only a last resort for
 * a server that ships ahead of this web bundle — not the normal path. Every
 * miss still reaches the i18n missing-key handler (Sentry in production),
 * which is how such a skew gets noticed.
 */

/** `manage_startup_items` -> "Manage startup items". */
export function sentenceCase(token: string): string {
  const words = token.replace(/[_:-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Enabled manual flows join the picker as per-organization `flow__<slug>`
 * tools (#5220, `useAgentToolCatalog.loadFlowTools`). Their names are tenant
 * data, so there is never a translation key for one; looking one up would
 * only report a "missing" key per flow per session.
 */
const FLOW_TOOL_PREFIX = 'flow__';

/**
 * A catalog tool with no label (server ahead of this bundle) falls back to the
 * app-wide tool-name formatter the AI Risk page and AI plan cards use, so
 * acronyms (EDR, DNS, AI, ...) render the same everywhere (#10197 makes it
 * acronym-aware).
 */
export function catalogToolLabel(t: CatalogTranslateFn, toolName: string): string {
  if (toolName.startsWith(FLOW_TOOL_PREFIX)) return sentenceCase(toolName);
  return t(/* i18n-dynamic */ `settings:aiAgentsPage.catalog.tools.${toolName}`, { defaultValue: formatToolName(toolName) });
}

/** A bare (action-less) operation is labelled by its tool. */
export function catalogActionLabel(t: CatalogTranslateFn, toolName: string, action: string | null): string {
  if (action === null) return catalogToolLabel(t, toolName);
  return t(/* i18n-dynamic */ `settings:aiAgentsPage.catalog.actions.${toolName}.${action}`, { defaultValue: sentenceCase(action) });
}

export function catalogCapabilityLabel(t: CatalogTranslateFn, id: string): string {
  return t(/* i18n-dynamic */ `settings:aiAgentsPage.catalog.capabilities.${id}.label`, { defaultValue: sentenceCase(id) });
}

export function catalogCapabilityDescription(t: CatalogTranslateFn, id: string): string {
  return t(/* i18n-dynamic */ `settings:aiAgentsPage.catalog.capabilities.${id}.description`, { defaultValue: '' });
}
