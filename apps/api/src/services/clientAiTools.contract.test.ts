/**
 * FF2 — cross-package wire-contract guard (SERVER side).
 *
 * The server tool registry CLIENT_TOOL_REGISTRIES[host] is the source of truth
 * for what tools each Office host exposes, which are mutating, and what
 * inputSchema param keys each accepts. The four add-in dispatchers must stay in
 * lockstep with it. To share that contract WITHOUT an api<->addin import, the
 * shape is mirrored into a checked-in JSON fixture in the one package every
 * add-in depends on:
 *   packages/office-addin-core/src/contract/client-tool-contract.json
 *
 * This test derives the live contract from CLIENT_TOOL_REGISTRIES and asserts it
 * deep-equals that fixture. The matching per-add-in dispatcher tests assert each
 * dispatcher's TOOL_EXECUTORS / MUTATING_TOOLS sets equal the fixture's host
 * slice. Net effect: a server-side tool rename/add/remove, a mutating-flag flip,
 * OR an inputSchema param-key rename on EITHER side fails a test with a clear
 * diff — caught at test time, not at runtime in someone's Excel.
 *
 * If you intentionally change the server registry, regenerate the fixture (the
 * failure diff tells you exactly what to write) and update the add-in
 * dispatchers + their tests in the same PR.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CLIENT_TOOL_REGISTRIES } from './clientAiTools';
import { CLIENT_HOSTS } from './clientAiHosts';

const CONTRACT_PATH = path.resolve(
  __dirname,
  '../../../../packages/office-addin-core/src/contract/client-tool-contract.json',
);

interface ContractEntry {
  mutating: boolean;
  paramKeys: string[];
}
type Contract = Record<string, Record<string, ContractEntry>>;

/** Re-derive the contract from the live registry, with deterministic ordering. */
function deriveContractFromRegistry(): Contract {
  const out: Contract = {};
  for (const host of [...CLIENT_HOSTS].sort()) {
    const reg = CLIENT_TOOL_REGISTRIES[host];
    const tools: Record<string, ContractEntry> = {};
    for (const [name, def] of Object.entries(reg).sort(([a], [b]) => a.localeCompare(b))) {
      tools[name] = {
        mutating: def.mutating,
        // inputSchema is a zod RAW SHAPE — its top-level keys ARE the param keys.
        paramKeys: Object.keys(def.inputSchema).sort(),
      };
    }
    out[host] = tools;
  }
  return out;
}

describe('client AI tool wire contract (server <-> add-in)', () => {
  const fixture = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as Contract;
  const derived = deriveContractFromRegistry();

  it('the checked-in fixture deep-equals the live server registry', () => {
    // A single deep-equal so any drift (added/removed/renamed tool, flipped
    // mutating flag, or renamed inputSchema param key) shows as one clear diff.
    expect(derived).toEqual(fixture);
  });

  it('covers every client host with a non-empty tool set', () => {
    for (const host of CLIENT_HOSTS) {
      const hostTools = fixture[host];
      expect(hostTools, `fixture missing host '${host}'`).toBeTruthy();
      expect(Object.keys(hostTools ?? {}).length).toBeGreaterThan(0);
    }
    // No stray hosts in the fixture that the server doesn't know about.
    expect(Object.keys(fixture).sort()).toEqual([...CLIENT_HOSTS].sort());
  });

  it('every mutating flag in the fixture matches the registry def', () => {
    for (const host of CLIENT_HOSTS) {
      const hostTools = fixture[host] ?? {};
      for (const [name, def] of Object.entries(CLIENT_TOOL_REGISTRIES[host])) {
        expect(hostTools[name]?.mutating, `${host}.${name} mutating mismatch`).toBe(def.mutating);
      }
    }
  });

  it('every fixture param-key list matches the registry inputSchema keys', () => {
    for (const host of CLIENT_HOSTS) {
      const hostTools = fixture[host] ?? {};
      for (const [name, def] of Object.entries(CLIENT_TOOL_REGISTRIES[host])) {
        expect(hostTools[name]?.paramKeys, `${host}.${name} paramKeys mismatch`).toEqual(
          Object.keys(def.inputSchema).sort(),
        );
      }
    }
  });
});
