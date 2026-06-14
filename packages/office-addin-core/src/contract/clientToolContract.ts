/**
 * AI for Office — checked-in cross-package wire contract (FF2).
 *
 * The SHARED SOURCE OF TRUTH for the per-host client tool surface, kept in the
 * one package every add-in already depends on (no api<->addin import). It
 * mirrors the SERVER registry CLIENT_TOOL_REGISTRIES[host] in
 * apps/api/src/services/clientAiTools.ts:
 *   { [host]: { [toolName]: { mutating, paramKeys (sorted) } } }
 *
 * The contract data lives in the sibling client-tool-contract.json fixture so a
 * single artifact can be consumed by BOTH the api (node) and the add-in (jsdom)
 * test environments. This module is a browser-safe const re-export (no fs, no
 * node builtins) — add-in app/tests import it via @breeze/office-addin-core.
 *
 * Two test guards keep both sides honest:
 *  - SERVER (apps/api .../clientAiTools.contract.test.ts): derives the live
 *    contract from CLIENT_TOOL_REGISTRIES and asserts it deep-equals this
 *    fixture. A server-side tool rename/add/remove, a mutating-flag flip, OR an
 *    inputSchema param-key rename fails loudly with a diff.
 *  - CLIENT (each apps/*-addin .../dispatcher.test.ts): asserts the dispatcher's
 *    TOOL_EXECUTORS key set and MUTATING_TOOLS set EXACTLY equal this host's
 *    contract tool-name / mutating sets. A client rename or mutating flip fails.
 */
import contract from './client-tool-contract.json';

export interface ClientToolContractEntry {
  mutating: boolean;
  /** Sorted top-level inputSchema param keys (the zod raw-shape keys). */
  paramKeys: string[];
}

/** host -> toolName -> entry. Keys are sorted for deterministic comparison. */
export type ClientToolContract = Record<string, Record<string, ClientToolContractEntry>>;

/** The checked-in contract fixture. */
export const CLIENT_TOOL_CONTRACT: ClientToolContract = contract as ClientToolContract;

/** Tool names for a host (sorted), or [] if the host is absent from the contract. */
export function contractToolNames(host: string): string[] {
  return Object.keys(CLIENT_TOOL_CONTRACT[host] ?? {}).sort();
}

/** Mutating tool names for a host (sorted). */
export function contractMutatingToolNames(host: string): string[] {
  return Object.entries(CLIENT_TOOL_CONTRACT[host] ?? {})
    .filter(([, def]) => def.mutating)
    .map(([name]) => name)
    .sort();
}
