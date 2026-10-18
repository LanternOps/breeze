import { z } from 'zod';
import { MCP_GRANTABLE_DOMAINS, type McpGrantableDomain } from '../types/aiToolDomains';

/**
 * Per-grant MCP tool domains (B-W02 #6156). `null` = unrestricted: every
 * domain, including domains added later and unclassified tools. A restricted
 * grant is a NON-EMPTY list of grantable domains — `[]` is rejected (plan Open
 * Decision 1, default A) so a zero-box selection is a loud 400, never a
 * silently near-useless connection. `core` is implicit and never stored.
 */
export const mcpDomainsInputSchema = z
  .array(z.enum(MCP_GRANTABLE_DOMAINS as [McpGrantableDomain, ...McpGrantableDomain[]]))
  .min(1)
  .max(MCP_GRANTABLE_DOMAINS.length)
  .nullable();

export type McpDomainsInput = z.infer<typeof mcpDomainsInputSchema>;

/**
 * Dedupe and order a validated selection. A list naming every grantable
 * domain collapses to `null`, so "all 13 today" never silently differs from
 * "all, including areas added later".
 */
export function normalizeMcpDomainsInput(
  value: readonly McpGrantableDomain[] | null,
): McpGrantableDomain[] | null {
  if (value === null) return null;
  const selected = new Set(value);
  const ordered = MCP_GRANTABLE_DOMAINS.filter((d) => selected.has(d));
  return ordered.length === MCP_GRANTABLE_DOMAINS.length ? null : ordered;
}
