---
tracking_issue: LanternOps/breeze#6154
wave_issue: LanternOps/breeze#6155
branch: feature/6154-mcp-modernization/wave-6155
---
# MCP server modernization B-W01: additive spec catch-up — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The external MCP server (`apps/api/src/routes/mcpServer.ts`) negotiates the protocol version instead of hard-coding `2024-11-05`, validates the `MCP-Protocol-Version` header, reports the real Breeze version in `serverInfo`, advertises every tool with a `title`, spec `annotations` (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`) and a `_meta` domain derived from the guardrail tier tables and A-W02 metadata, returns `tools/list` in a deterministic order with opt-in pagination, returns `structuredContent` beside the text block on `tools/call`, and the docs plus the `ai-agent` skill lead with Streamable HTTP. A per-version conformance contract test pins all of it.

**Architecture:** Everything is additive and hand-rolled — the server is a Hono router with hand-written JSON-RPC (`mcpServer.ts:240-253`), not `@modelcontextprotocol/sdk`, and stays that way. New logic lives in two leaf modules so the 2,626-line route file gets small, reviewable edits: `services/mcpProtocol.ts` (version set, negotiation, header parsing, cursor codec) and `services/mcpToolPresentation.ts` (title, annotations, `_meta` from tier tables + `getToolDomain`). Annotations are derived per action from `TIER1/2/3_ACTIONS` and `isReadOnlyResolution` and a contract test proves they are never *looser* than `checkGuardrails` — the same "never weaker than the route" posture as #6096/#6110. `annotations`, `title`, `_meta` and `structuredContent` are emitted for every negotiated version (older clients ignore unknown fields); pagination is dormant by default (`MCP_TOOLS_LIST_PAGE_SIZE` unset = single page) because a client that ignores `nextCursor` would otherwise lose tools.

**Tech Stack:** TypeScript, Hono, Vitest (the `mcpServer.streamable.test.ts` mock harness), MCP spec revisions 2024-11-05 / 2025-03-26 / 2025-06-18 / 2025-11-25.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization-design.md` — "Feature B → B-W01", Principles 3 and 4; issue #6143 W1 table. Plan index decision D8.

**Tracking:** `get_feature_status LanternOps/breeze#6154`; `start_wave` on #6155; PR `Closes #6155`. **Depends on A-W02 (#6149) merged** for `getToolDomain`. If A-W02 is not on `main` yet, branch from its reviewed head and rebase after its squash-merge (`git rebase --onto origin/main <old A-W02 tip>`).

**Verified against `origin/main` `5f20013cb`** (2026-09-17).

---

## Global Constraints

- **Commands.** `cd apps/api && npx vitest run <path>`; typecheck `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`; `pnpm lint`; docs `cd apps/docs && pnpm astro check`. **Before the PR: `cd apps/api && npx vitest run src/routes/mcpServer`** (substring: all 17 `mcpServer.*.test.ts` files — check the count) **and then the whole unit suite.**
- **No auth changes, no session changes, no new tables.** `mcpAuthMiddleware` (`:207-233`), `preflightMcpRequest` (`:430-471`), session minting/ownership (`:721-850`) and the tier-3 deny paths (`isToolWhollyGatedOverMcp` `:1013`, `isMcpApprovalRequired` `:997`, `:1316`) are untouched. `DELETE /sse` stays a 204 no-op (B-W03's problem, not this wave's) — the docs must not claim it ends a session.
- **`MCP_EXECUTE_TOOL_ALLOWLIST` (`:85,1338`) is probably dead code** (#6141, *inferred*). Do not delete it in passing.
- **`buildInitializeResult()` is exported and pinned by `mcpServer.initialize.test.ts`** — its signature changes here, and that test is rewritten in the same commit.
- **`serverInfo.version` = `API_VERSION` from `apps/api/src/version.ts:1`** (`APP_VERSION` env, fallback `'0.2.0'`). Not `HOST_BREEZE_VERSION` (`extensions/hostDescriptor.ts:62`), not the agent-binary `BREEZE_VERSION`. Tests must not assert a literal.
- **Annotations are per tool; tiering is per action.** Rule: `readOnlyHint` is true only when **every** action (or the whole tool, when there is no `action` enum) resolves read-only; `destructiveHint` is true when **any** action resolves to tier ≥ 3; `idempotentHint` = `readOnlyHint`; `openWorldHint` = `domain === 'integrations'`. Annotations may be **stricter** than `checkGuardrails`, never looser — the contract test enforces the direction.
- **`readOnlyHint` comes from `isReadOnlyResolution`** (`aiGuardrails.ts:1681`) fed with the per-action tier, not from `tier === 1` (`TIER1_NON_READONLY_TOOLS` and `TIER2_READONLY_*` both exist).
- **`structuredContent` must be built from the redacted `safeResult`**, never from the raw `result` (`compactToolResultForChat` is the redaction boundary, `:1415`). The existing image branch parses raw `result` at `:1421`; leave it, do not copy it.
- **Deterministic order = `localeCompare('en')` by name**, core registry first then tenant (BYO MCP) tools, both sorted. The tenant read may fail and degrade to `[]` (`:1186-1200`); a cursor is an offset into the per-principal list and is best-effort across that degradation (documented).
- **Docs:** both transports share the path `/api/v1/mcp/sse` — `GET` = legacy HTTP+SSE stream, `POST` = Streamable HTTP. The docs must say so or readers will look for a second URL.
- **Commit after every task.** Trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/src/services/mcpProtocol.ts` (+ `.test.ts`) | Supported versions, negotiation, header parse, cursor codec, page size (Task 1). |
| `apps/api/src/routes/mcpServer.ts` `buildInitializeResult` `:876-890`, `handleJsonRpc` `:902`, `POST /sse` `:721+` | Negotiation + `serverInfo` + header validation (Task 2). |
| `apps/api/src/routes/mcpServer.initialize.test.ts` | Rewritten (Task 2). |
| `apps/api/src/services/mcpToolPresentation.ts` (+ `.test.ts`, `mcpToolPresentation.guardrailParity.contract.test.ts`) | `title`, `annotations`, `_meta` (Task 3). |
| `apps/api/src/routes/mcpServer.ts` `handleToolsList` `:1125-1203` | Presentation, ordering, pagination (Task 4). |
| `apps/api/src/routes/mcpServer.ts` `handleToolsCall` result shaping `:1414-1440` | `structuredContent` (Task 5). |
| `apps/docs/src/content/docs/features/mcp-server.mdx`, `.claude/skills/ai-agent/SKILL.md` | Streamable HTTP first (Task 6). |
| `apps/api/src/routes/mcpServer.conformance.contract.test.ts` | Per-version conformance (Task 7). |

---

### Task 1: `mcpProtocol.ts`

**Files:**
- Create: `apps/api/src/services/mcpProtocol.ts`, `apps/api/src/services/mcpProtocol.test.ts`

**Interfaces produced:**

```ts
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;  // newest first
export type McpProtocolVersion = (typeof SUPPORTED_MCP_PROTOCOL_VERSIONS)[number];
export const LATEST_MCP_PROTOCOL_VERSION: McpProtocolVersion;            // '2025-11-25'
export const ASSUMED_MCP_PROTOCOL_VERSION: McpProtocolVersion;           // '2025-03-26' — what the spec says to assume when the header is absent
export function isSupportedMcpProtocolVersion(v: unknown): v is McpProtocolVersion;
/** Spec: echo a supported requested version; otherwise answer with the latest we support. */
export function negotiateMcpProtocolVersion(requested: unknown): McpProtocolVersion;
/** `MCP-Protocol-Version` header on non-initialize Streamable HTTP requests. */
export function parseMcpProtocolVersionHeader(value: string | undefined): { ok: true; version: McpProtocolVersion; assumed: boolean } | { ok: false; value: string };
export function encodeToolsListCursor(offset: number): string;             // base64url of {"v":1,"offset":n}
export function decodeToolsListCursor(cursor: unknown): number | null;     // null = invalid
/** MCP_TOOLS_LIST_PAGE_SIZE env; 0/unset = single page. */
export function mcpToolsListPageSize(env: NodeJS.ProcessEnv = process.env): number;
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  ASSUMED_MCP_PROTOCOL_VERSION, LATEST_MCP_PROTOCOL_VERSION, SUPPORTED_MCP_PROTOCOL_VERSIONS,
  decodeToolsListCursor, encodeToolsListCursor, mcpToolsListPageSize, negotiateMcpProtocolVersion, parseMcpProtocolVersionHeader,
} from './mcpProtocol';

describe('mcpProtocol', () => {
  it('supports the four revisions newest-first and still speaks 2024-11-05', () => {
    expect([...SUPPORTED_MCP_PROTOCOL_VERSIONS]).toEqual(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
    expect(LATEST_MCP_PROTOCOL_VERSION).toBe('2025-11-25');
    expect(ASSUMED_MCP_PROTOCOL_VERSION).toBe('2025-03-26');
  });
  it('echoes a supported requested version and answers latest for anything else', () => {
    expect(negotiateMcpProtocolVersion('2024-11-05')).toBe('2024-11-05');
    expect(negotiateMcpProtocolVersion('2025-06-18')).toBe('2025-06-18');
    expect(negotiateMcpProtocolVersion('2026-07-28')).toBe('2025-11-25');   // B-W03 territory, not yet
    expect(negotiateMcpProtocolVersion(undefined)).toBe('2025-11-25');
    expect(negotiateMcpProtocolVersion(42)).toBe('2025-11-25');
  });
  it('parses the header: absent = assumed 2025-03-26, supported = ok, anything else = reject', () => {
    expect(parseMcpProtocolVersionHeader(undefined)).toEqual({ ok: true, version: '2025-03-26', assumed: true });
    expect(parseMcpProtocolVersionHeader('2025-11-25')).toEqual({ ok: true, version: '2025-11-25', assumed: false });
    expect(parseMcpProtocolVersionHeader('1999-01-01')).toEqual({ ok: false, value: '1999-01-01' });
    expect(parseMcpProtocolVersionHeader('')).toEqual({ ok: true, version: '2025-03-26', assumed: true });
  });
  it('round-trips an opaque offset cursor and rejects garbage', () => {
    expect(decodeToolsListCursor(encodeToolsListCursor(50))).toBe(50);
    expect(encodeToolsListCursor(50)).not.toContain('=');
    expect(decodeToolsListCursor('not-base64!')).toBeNull();
    expect(decodeToolsListCursor(Buffer.from('{"v":2,"offset":1}').toString('base64url'))).toBeNull();
    expect(decodeToolsListCursor(Buffer.from('{"v":1,"offset":-1}').toString('base64url'))).toBeNull();
    expect(decodeToolsListCursor(undefined)).toBeNull();
  });
  it('reads the page size from env, 0 when unset or invalid', () => {
    expect(mcpToolsListPageSize({})).toBe(0);
    expect(mcpToolsListPageSize({ MCP_TOOLS_LIST_PAGE_SIZE: '50' })).toBe(50);
    expect(mcpToolsListPageSize({ MCP_TOOLS_LIST_PAGE_SIZE: 'x' })).toBe(0);
    expect(mcpToolsListPageSize({ MCP_TOOLS_LIST_PAGE_SIZE: '-3' })).toBe(0);
  });
});
```

Run: `cd apps/api && npx vitest run src/services/mcpProtocol.test.ts` → FAIL.

- [ ] **Step 2: Implement** — plain functions, no imports beyond Node `Buffer`. `decodeToolsListCursor`: `typeof cursor === 'string'`, base64url-decode, `JSON.parse` in try/catch, require `v === 1` and `Number.isInteger(offset) && offset >= 0`.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/mcpProtocol.test.ts
git add apps/api/src/services/mcpProtocol.ts apps/api/src/services/mcpProtocol.test.ts && git commit -m "feat(mcp): protocol version set, negotiation, header parse, cursor codec (B-W01)"
```

---

### Task 2: Version negotiation, `serverInfo`, header validation

**Files:**
- Modify: `apps/api/src/routes/mcpServer.ts` (`buildInitializeResult` `:876-890`; `case 'initialize'` `:902`; `POST /sse` handler after preflight `:728`)
- Rewrite: `apps/api/src/routes/mcpServer.initialize.test.ts`

**Interfaces produced:** `buildInitializeResult(requestedProtocolVersion?: unknown)` returning `{ protocolVersion, capabilities, serverInfo: { name: 'breeze-rmm', title: 'Breeze RMM', version: API_VERSION }, instructions }`.

- [ ] **Step 1: Rewrite the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildInitializeResult } from './mcpServer';
import { API_VERSION } from '../version';

describe('buildInitializeResult (B-W01)', () => {
  it('negotiates: echoes a supported version, answers latest otherwise, defaults to latest', () => {
    expect(buildInitializeResult('2024-11-05').protocolVersion).toBe('2024-11-05');
    expect(buildInitializeResult('2025-06-18').protocolVersion).toBe('2025-06-18');
    expect(buildInitializeResult('2026-07-28').protocolVersion).toBe('2025-11-25');
    expect(buildInitializeResult().protocolVersion).toBe('2025-11-25');
  });
  it('reports the Breeze API version and a human title', () => {
    expect(buildInitializeResult().serverInfo).toEqual({ name: 'breeze-rmm', title: 'Breeze RMM', version: API_VERSION });
    expect(typeof API_VERSION).toBe('string');
    expect(API_VERSION.length).toBeGreaterThan(0);
  });
  it('returns a non-empty instructions string and advertises the prompts capability', () => {
    const r = buildInitializeResult();
    expect(r.instructions.length).toBeGreaterThan(200);
    expect(r.capabilities.prompts).toEqual({ listChanged: false });
  });
});
```

Run → FAIL (`serverInfo.version === '1.0.0'`, no negotiation).

- [ ] **Step 2: Implement**

```ts
import { API_VERSION } from '../version';
import { negotiateMcpProtocolVersion, parseMcpProtocolVersionHeader } from '../services/mcpProtocol';

export function buildInitializeResult(requestedProtocolVersion?: unknown) {
  return {
    protocolVersion: negotiateMcpProtocolVersion(requestedProtocolVersion),
    capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } },
    serverInfo: { name: 'breeze-rmm', title: 'Breeze RMM', version: API_VERSION },
    instructions: MCP_SERVER_INSTRUCTIONS,
  };
}
```

`handleJsonRpc` `case 'initialize'`: `return jsonRpcResult(req.id, buildInitializeResult((req.params as { protocolVersion?: unknown } | undefined)?.protocolVersion));`

`POST /sse` (Streamable HTTP), right after `const isInitialize = pre.body.method === 'initialize';`:

```ts
    // 2025-06-18 §Protocol Version Header: clients MUST send MCP-Protocol-Version
    // on every request after initialize; an unsupported value is a 400. Absent
    // = assume 2025-03-26 (backwards compatibility). Initialize itself carries
    // the version in params, so the header is not checked there.
    if (!isInitialize) {
      const parsed = parseMcpProtocolVersionHeader(c.req.header('MCP-Protocol-Version'));
      if (!parsed.ok) {
        return c.json(
          { jsonrpc: '2.0', id: pre.body.id ?? null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version: ${parsed.value}` } },
          400,
        );
      }
    }
```

The legacy `POST /message` path (`:561`) is the 2024-11-05 transport and gets no header check.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/routes/mcpServer.initialize.test.ts src/routes/mcpServer.streamable.test.ts src/routes/mcpServer.test.ts
git add apps/api/src/routes && git commit -m "feat(mcp): negotiate protocol version, real serverInfo.version, MCP-Protocol-Version header check (B-W01)"
```

---

### Task 3: Tool presentation — `title`, `annotations`, `_meta`

**Files:**
- Create: `apps/api/src/services/mcpToolPresentation.ts`, `mcpToolPresentation.test.ts`, `mcpToolPresentation.guardrailParity.contract.test.ts`

**Interfaces produced:**

```ts
export interface McpToolAnnotations { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
export interface McpToolPresentation { title: string; annotations: McpToolAnnotations; _meta: { 'app.breeze/domain': string } }
export function mcpToolTitle(name: string): string;                       // manage_alert_rules → "Manage alert rules"; m365_query_users → "M365 query users"
export function resolveActionTier(toolName: string, action: string | undefined, baseTier: number): number;
export function isActionReadOnly(toolName: string, action: string | undefined, baseTier: number): boolean;
export function buildMcpToolPresentation(tool: { name: string; input_schema?: unknown }, baseTier: number | undefined, domain: string | undefined): McpToolPresentation;
```

- [ ] **Step 1: Write the failing unit test**

```ts
import { describe, expect, it } from 'vitest';
import { buildMcpToolPresentation, isActionReadOnly, mcpToolTitle, resolveActionTier } from './mcpToolPresentation';

describe('mcpToolTitle', () => {
  it('humanizes snake_case and upper-cases known acronyms', () => {
    expect(mcpToolTitle('manage_alert_rules')).toBe('Manage alert rules');
    expect(mcpToolTitle('m365_query_users')).toBe('M365 query users');
    expect(mcpToolTitle('get_s1_threats')).toBe('Get S1 threats');
    expect(mcpToolTitle('query_c2c_connections')).toBe('Query C2C connections');
    expect(mcpToolTitle('get_dns_security')).toBe('Get DNS security');
  });
});

describe('per-action tier + read-only resolution (mirrors aiGuardrails tables)', () => {
  it('escalates by TIER3_ACTIONS, downgrades by TIER1_ACTIONS, falls back to base', () => {
    expect(resolveActionTier('manage_services', 'restart', 2)).toBe(3);      // TIER3_ACTIONS.manage_services
    expect(resolveActionTier('manage_services', 'list', 2)).toBe(2);
    expect(resolveActionTier('query_devices', undefined, 1)).toBe(1);
  });
  it('read-only follows isReadOnlyResolution semantics', () => {
    expect(isActionReadOnly('query_devices', undefined, 1)).toBe(true);
    expect(isActionReadOnly('manage_services', 'list', 2)).toBe(true);        // TIER2_READONLY_ACTIONS
    expect(isActionReadOnly('manage_services', 'restart', 2)).toBe(false);
    expect(isActionReadOnly('list_contracts', undefined, 2)).toBe(true);       // TIER2_READONLY_TOOLS
    expect(isActionReadOnly('workspace_read', undefined, 1)).toBe(false);      // TIER1_NON_READONLY_TOOLS
  });
});

describe('buildMcpToolPresentation', () => {
  const schema = (actions: string[]) => ({ type: 'object', properties: { action: { type: 'string', enum: actions } } });
  it('a pure read tool: readOnly + idempotent, not destructive, closed world', () => {
    expect(buildMcpToolPresentation({ name: 'query_devices' }, 1, 'core')).toEqual({
      title: 'Query devices',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { 'app.breeze/domain': 'core' },
    });
  });
  it('a mixed multiplexer: not read-only, destructive when any action is tier 3', () => {
    const p = buildMcpToolPresentation({ name: 'manage_services', input_schema: schema(['list', 'start', 'stop', 'restart']) }, 2, 'devices');
    expect(p.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  });
  it('a tier-2 write multiplexer with no tier-3 action: not read-only, not destructive', () => {
    const p = buildMcpToolPresentation({ name: 'manage_groups', input_schema: schema(['list', 'get', 'create', 'update']) }, 2, 'devices');
    expect(p.annotations.readOnlyHint).toBe(false);
    expect(p.annotations.destructiveHint).toBe(false);
  });
  it('integrations are open-world; unknown tier is treated as destructive (fail closed) and unknown domain as "unknown"', () => {
    expect(buildMcpToolPresentation({ name: 'get_s1_threats' }, 1, 'integrations').annotations.openWorldHint).toBe(true);
    const p = buildMcpToolPresentation({ name: 'mystery' }, undefined, undefined);
    expect(p.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
    expect(p._meta['app.breeze/domain']).toBe('unknown');
  });
});
```

Run → FAIL.

- [ ] **Step 2: Write the failing parity contract test**

```ts
/**
 * B-W01 contract: MCP annotations may be STRICTER than checkGuardrails,
 * never LOOSER. For every registered tool × declared action:
 *   - if guardrails say the resolution is NOT read-only, the tool's
 *     readOnlyHint must be false;
 *   - if guardrails resolve tier 3, destructiveHint must be true.
 * No vi.mock.
 */
import { describe, expect, it } from 'vitest';
import { aiTools } from './aiToolNames';
import './aiTools';
import { getToolDomain, getToolTier } from './aiTools';
import { checkGuardrails, isReadOnlyResolution } from './aiGuardrails';
import { buildMcpToolPresentation } from './mcpToolPresentation';

function actionsOf(schema: unknown): (string | undefined)[] {
  const values = (schema as { properties?: { action?: { enum?: unknown[] } } })?.properties?.action?.enum;
  const actions = Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : [];
  return actions.length > 0 ? actions : [undefined];
}

describe('MCP annotations vs checkGuardrails (never looser)', () => {
  const looser: string[] = [];
  for (const [name, tool] of aiTools) {
    const p = buildMcpToolPresentation(tool.definition, getToolTier(name), getToolDomain(name));
    for (const action of actionsOf(tool.definition.input_schema)) {
      const check = checkGuardrails(name, action ? { action } : {});
      if (check.tier === 4) continue;                         // blocked tools never list
      const guardReadOnly = isReadOnlyResolution(name, check);
      if (!guardReadOnly && p.annotations.readOnlyHint) looser.push(`${name}${action ? ':' + action : ''} claims readOnly but guardrails say mutation`);
      if (check.tier >= 3 && !p.annotations.destructiveHint) looser.push(`${name}${action ? ':' + action : ''} is tier 3 but not destructiveHint`);
    }
  }
  it('has a populated registry', () => { expect(aiTools.size).toBeGreaterThan(150); });
  it('never advertises a looser hint than the guardrails enforce', () => { expect(looser).toEqual([]); });
});
```

Run → FAIL (module missing). Note `checkGuardrails(name, input, context?)` (`aiGuardrails.ts:1732`) — call it without context; if any tool needs `TIER3_INPUT_AWARE_ACTIONS`-style input beyond `action`, guardrails may resolve tier 3 where the tables alone say 2 — the parity test will name it and `buildMcpToolPresentation` must then treat that tool as destructive (add the name to a `INPUT_AWARE_DESTRUCTIVE` set in `mcpToolPresentation.ts` that forces `destructiveHint: true`, with a comment citing the test). Never the other direction.

- [ ] **Step 3: Implement**

```ts
import { TIER1_ACTIONS, TIER2_ACTIONS, TIER2_READONLY_ACTIONS, TIER3_ACTIONS, isReadOnlyResolution } from './aiGuardrails';

const ACRONYMS = new Set(['m365', 's1', 'c2c', 'dns', 'cis', 'pam', 'dr', 'sla', 'vm', 'mssql', 'ip', 'os', 'psa', 'ui', 'api', 'id', 'usb', 'pprof']);

export function mcpToolTitle(name: string): string {
  return name.split('_').map((w, i) => {
    if (ACRONYMS.has(w)) return w === 'pprof' ? w : w.toUpperCase();
    return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w;
  }).join(' ');
}

export function resolveActionTier(toolName: string, action: string | undefined, baseTier: number): number {
  if (action) {
    if (TIER3_ACTIONS[toolName]?.includes(action)) return 3;
    if (TIER2_ACTIONS[toolName]?.includes(action)) return 2;
    if (TIER1_ACTIONS[toolName]?.includes(action)) return 1;
  }
  return baseTier;
}

export function isActionReadOnly(toolName: string, action: string | undefined, baseTier: number): boolean {
  const tier = resolveActionTier(toolName, action, baseTier);
  const readOnlyAction = tier === 2 && action !== undefined && (TIER2_READONLY_ACTIONS[toolName]?.includes(action) ?? false);
  return isReadOnlyResolution(toolName, { tier: tier as 1 | 2 | 3 | 4, readOnly: readOnlyAction });
}

function actionEnum(inputSchema: unknown): string[] {
  const values = (inputSchema as { properties?: { action?: { enum?: unknown[] } } } | undefined)?.properties?.action?.enum;
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : [];
}

export function buildMcpToolPresentation(tool: { name: string; input_schema?: unknown }, baseTier: number | undefined, domain: string | undefined): McpToolPresentation {
  const title = mcpToolTitle(tool.name);
  const meta = { 'app.breeze/domain': domain ?? 'unknown' };
  if (baseTier === undefined) {
    return { title, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, _meta: meta };
  }
  const actions = actionEnum(tool.input_schema);
  const targets: (string | undefined)[] = actions.length > 0 ? actions : [undefined];
  const readOnlyHint = targets.every((a) => isActionReadOnly(tool.name, a, baseTier));
  const destructiveHint = targets.some((a) => resolveActionTier(tool.name, a, baseTier) >= 3);
  return {
    title,
    annotations: { readOnlyHint, destructiveHint, idempotentHint: readOnlyHint, openWorldHint: domain === 'integrations' },
    _meta: meta,
  };
}
```

(`TIER1_ACTIONS` `aiGuardrails.ts:205`, `TIER2_ACTIONS` `:51`, `TIER3_ACTIONS` `:212`, `TIER2_READONLY_ACTIONS` `:161` are all exported; `isReadOnlyResolution` `:1681`.)

- [ ] **Step 4: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/mcpToolPresentation
git add apps/api/src/services && git commit -m "feat(mcp): tool title/annotations/_meta from tier tables + domain, never looser than guardrails (B-W01)"
```

---

### Task 4: `tools/list` — presentation, deterministic order, pagination

**Files:**
- Modify: `apps/api/src/routes/mcpServer.ts` `handleToolsList` (`:1125-1203`), `handleJsonRpc` `case 'tools/list'` (`:909` — pass `req.params`)
- Modify: `apps/api/src/routes/mcpServer.streamable.test.ts` or `mcpServer.test.ts` (new assertions)

- [ ] **Step 1: Write the failing tests** — in `mcpServer.streamable.test.ts` (it already mocks `getToolDefinitions`/`getToolTier` and has `appWithMcpRoutes()`), add a describe using three tools returned **out of order**:

```ts
describe('tools/list presentation + ordering + pagination (B-W01)', () => {
  const tools = [
    { name: 'query_devices', description: 'd', input_schema: { type: 'object', properties: {} } },
    { name: 'manage_services', description: 'd', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'restart'] } } } },
    { name: 'get_backup_status', description: 'd', input_schema: { type: 'object', properties: {} } },
  ];
  beforeEach(() => {
    mocks.getToolDefinitions.mockReturnValue(tools);
    mocks.getToolTier.mockImplementation((n: string) => (n === 'manage_services' ? 2 : 1));
  });

  async function listWith(params?: Record<string, unknown>) {
    const app = appWithMcpRoutes();
    const init = await app.request('/mcp/sse', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) });
    const sid = init.headers.get('Mcp-Session-Id')!;
    const res = await app.request('/mcp/sse', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k', 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params }) });
    return (await res.json()).result as { tools: Array<Record<string, unknown>>; nextCursor?: string };
  }

  it('sorts by name and decorates every tool with title, annotations and _meta', async () => {
    const { tools: listed, nextCursor } = await listWith();
    expect(listed.map((t) => t.name)).toEqual(['get_backup_status', 'manage_services', 'query_devices']);
    expect(nextCursor).toBeUndefined();
    expect(listed[0]).toMatchObject({ title: 'Get backup status', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: { 'app.breeze/domain': expect.any(String) } });
    expect(listed[1]!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(listed[1]!.inputSchema).toBeDefined();
  });

  it('paginates when MCP_TOOLS_LIST_PAGE_SIZE is set and rejects a bad cursor', async () => {
    vi.stubEnv('MCP_TOOLS_LIST_PAGE_SIZE', '2');
    try {
      const page1 = await listWith();
      expect(page1.tools.map((t) => t.name)).toEqual(['get_backup_status', 'manage_services']);
      expect(page1.nextCursor).toEqual(expect.any(String));
      const page2 = await listWith({ cursor: page1.nextCursor });
      expect(page2.tools.map((t) => t.name)).toEqual(['query_devices']);
      expect(page2.nextCursor).toBeUndefined();
      const app = appWithMcpRoutes();
      const init = await app.request('/mcp/sse', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
      const bad = await app.request('/mcp/sse', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k', 'Mcp-Session-Id': init.headers.get('Mcp-Session-Id')! }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { cursor: '!!' } }) });
      expect((await bad.json()).error.code).toBe(-32602);
    } finally { vi.unstubAllEnvs(); }
  });
});
```

The test file mocks `../services/aiTools` for `getToolDefinitions`/`getToolTier`/`executeTool` — add `getToolDomain: vi.fn(() => 'devices')` to that mock factory (Task 4's route code imports it).

Run → FAIL.

- [ ] **Step 2: Implement**

In `handleToolsList(id, scopes, auth, params?: Record<string, unknown>)`:

1. After building `result` (the mapped core tools, `:1157-1170`), decorate each:
   ```ts
   const presentation = buildMcpToolPresentation(tool, getToolTier(tool.name), getToolDomain(tool.name));
   return { name: tool.name, title: presentation.title, description, inputSchema: tool.input_schema, annotations: presentation.annotations, _meta: presentation._meta };
   ```
2. Tenant tools (`tenantResult`, `:1186-1200`): decorate with `buildMcpToolPresentation(d.definition, d.tier, 'integrations')` (BYO MCP tools are third-party by definition; `openWorldHint` true follows from the domain).
3. Order + page:
   ```ts
   const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en');
   const all = [...result.sort(byName), ...tenantResult.sort(byName)];
   const pageSize = mcpToolsListPageSize();
   if (pageSize <= 0) return jsonRpcResult(id, { tools: all });
   const offset = params?.cursor === undefined ? 0 : decodeToolsListCursor(params.cursor);
   if (offset === null) return jsonRpcError(id, -32602, 'Invalid cursor');
   const page = all.slice(offset, offset + pageSize);
   const next = offset + pageSize < all.length ? encodeToolsListCursor(offset + pageSize) : undefined;
   return jsonRpcResult(id, next ? { tools: page, nextCursor: next } : { tools: page });
   ```
4. `handleJsonRpc`: `case 'tools/list': return await handleToolsList(req.id, scopes, auth, req.params);`

Imports: `getToolDomain` from `../services/aiTools`; `buildMcpToolPresentation` from `../services/mcpToolPresentation`; `decodeToolsListCursor, encodeToolsListCursor, mcpToolsListPageSize` from `../services/mcpProtocol`. Add `MCP_TOOLS_LIST_PAGE_SIZE` to `apps/api/.env.example` and `docs/deploy/environment` (the docs page that lists MCP env vars — `apps/docs/src/content/docs/deploy/environment.mdx`) with "0/unset = single page; set to e.g. 50 once every connected client honours nextCursor".

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/routes/mcpServer.streamable.test.ts src/routes/mcpServer.approvalGate.test.ts src/routes/mcpServer.effectiveTier.test.ts src/routes/mcpServer.bootstrapCarveout.test.ts src/routes/mcpServer.test.ts
git add apps/api apps/docs && git commit -m "feat(mcp): tools/list annotations + title + _meta, name order, opt-in pagination (B-W01)"
```

---

### Task 5: `tools/call` — `structuredContent` beside the text block

**Files:**
- Modify: `apps/api/src/routes/mcpServer.ts` result shaping (`:1414-1440`)
- Modify: `apps/api/src/routes/mcpServer.streamable.test.ts` (new describe)

- [ ] **Step 1: Write the failing test**

```ts
describe('tools/call structuredContent (B-W01)', () => {
  async function call(resultText: string) {
    mocks.getToolDefinitions.mockReturnValue([{ name: 'query_devices', description: 'd', input_schema: { type: 'object', properties: {} } }]);
    mocks.getToolTier.mockReturnValue(1);
    mocks.executeTool.mockResolvedValue(resultText);
    const app = appWithMcpRoutes();
    const init = await app.request('/mcp/sse', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
    const res = await app.request('/mcp/sse', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k', 'Mcp-Session-Id': init.headers.get('Mcp-Session-Id')! }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'query_devices', arguments: {} } }) });
    return (await res.json()).result as { content: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };
  }
  it('mirrors an object result into structuredContent and keeps the text block', async () => {
    const r = await call(JSON.stringify({ devices: [{ id: 'd1' }], showing: 1 }));
    expect(r.content[0]).toEqual({ type: 'text', text: JSON.stringify({ devices: [{ id: 'd1' }], showing: 1 }) });
    expect(r.structuredContent).toEqual({ devices: [{ id: 'd1' }], showing: 1 });
  });
  it('omits structuredContent for non-object results (arrays, scalars, plain text)', async () => {
    expect((await call('[1,2]')).structuredContent).toBeUndefined();
    expect((await call('plain text')).structuredContent).toBeUndefined();
    expect((await call('"str"')).structuredContent).toBeUndefined();
  });
  it('builds structuredContent from the redacted text, not the raw result', async () => {
    const r = await call(JSON.stringify({ apiToken: 'secret-value', ok: true }));
    // compactToolResultForChat/redactAiToolOutputText replaces token-shaped values; whatever the text block shows, structuredContent must equal it.
    expect(r.structuredContent).toEqual(JSON.parse(r.content[0]!.text!));
  });
});
```

(If the redactor is mocked away in this file, the third test still holds — equality between the two representations is the contract.) Run → FAIL.

- [ ] **Step 2: Implement** — in the `else` branch at `:1432` and the `catch` fallback at `:1438`:

```ts
function structuredFromSafeText(safeText: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(safeText);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch { return undefined; }
}
// …
const structured = structuredFromSafeText(safeResult);
response = jsonRpcResult(id, structured
  ? { content: [{ type: 'text', text: safeResult }], structuredContent: structured }
  : { content: [{ type: 'text', text: safeResult }] });
```

Apply the same to the tenant-tool call path if it shapes its own result (`:1524-1560` region — grep `content: [{ type: 'text'` inside `handleToolsCall`). Error results (`isError: true`) stay text-only.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/routes/mcpServer.streamable.test.ts src/routes/mcpServer.deviceProjection.test.ts src/routes/mcpServer.deprecatedAlias.test.ts
git add apps/api/src/routes && git commit -m "feat(mcp): structuredContent beside the text block on tools/call (B-W01)"
```

---

### Task 6: Docs and the `ai-agent` skill lead with Streamable HTTP

**Files:**
- Modify: `apps/docs/src/content/docs/features/mcp-server.mdx` (`## Transport` `:30-41`; every client config sample `:128-195` and the `:186` Cursor block; env table `:523`)
- Modify: `.claude/skills/ai-agent/SKILL.md` (`:14-24` diagram label, `:53` and `:137` tool counts, `:262-266` connect snippet)

- [ ] **Step 1: Rewrite the Transport section** to this structure:

```mdx
## Transport

Breeze speaks both remote MCP transports on the **same path**, `/api/v1/mcp/sse`:

| Transport | How | Protocol revisions | Use it when |
|---|---|---|---|
| **Streamable HTTP** (recommended) | `POST /api/v1/mcp/sse` with a JSON-RPC body; the server answers inline JSON and issues an `Mcp-Session-Id` on `initialize` that you echo on every later request, plus the `MCP-Protocol-Version` header. | 2025-03-26, 2025-06-18, 2025-11-25 (negotiated on `initialize`) | Claude Code, Claude Desktop, Cursor, ChatGPT and any client released after mid-2025. |
| HTTP + SSE (legacy) | `GET /api/v1/mcp/sse` opens the event stream; the `endpoint` event names `/api/v1/mcp/message` for `POST`s. | 2024-11-05 | Older clients that only offer an "SSE" transport option. |

`initialize` reports the negotiated `protocolVersion`, `serverInfo.version` (the Breeze release), and `instructions`. Every tool in `tools/list` carries a `title`, MCP `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) derived from Breeze's tool tiers so clients can auto-approve reads, and `_meta["app.breeze/domain"]`. `tools/call` returns the JSON result both as a `text` block and as `structuredContent`. `tools/list` is paginated only when the operator sets `MCP_TOOLS_LIST_PAGE_SIZE`.
```

Then in each client sample, keep the URL (unchanged path) and add `"type": "http"` where the client's config schema has a transport field (Claude Desktop/Cursor JSON: add `"transport": "http"` only if that client documents it; otherwise leave the JSON as is and add one sentence: "This URL is the Streamable HTTP endpoint; the client negotiates the protocol version automatically."). Add a Claude Code block:

```bash
claude mcp add --transport http breeze-rmm https://your-breeze-instance.example.com/api/v1/mcp/sse \
  --header "X-API-Key: brz_your_api_key_here"
```

Env table (`:523`): add the `MCP_TOOLS_LIST_PAGE_SIZE` row.

- [ ] **Step 2: Skill** — `SKILL.md:262-266` becomes the `--transport http` block above; `:14-24` label "MCP over Streamable HTTP (legacy SSE kept)"; `:53` "12 MCP tool implementations" → "the AI tool registry (~200 tools across `aiTools*.ts`; `getToolDefinitions()` is the count)"; `:137` heading "## 12 MCP Tools" → "## MCP tools" with one sentence pointing at the registry and the generated prompt index (A-W02) instead of a stale table (delete the table rows or keep them only if every row is still a registered tool — check with `grep -c`).

- [ ] **Step 3: Verify and commit**

```bash
cd apps/docs && pnpm astro check
git add apps/docs .claude/skills/ai-agent/SKILL.md && git commit -m "docs(mcp): lead with Streamable HTTP; annotations, structuredContent, pagination env; fix stale tool count (B-W01)"
```

---

### Task 7: Per-version conformance contract test

**Files:**
- Create: `apps/api/src/routes/mcpServer.conformance.contract.test.ts` (copy the mock preamble from `mcpServer.streamable.test.ts:1-190` verbatim — `mocks`, `envState`, `redisState`, the `vi.mock` blocks, `setApiKeyContext`, `appWithMcpRoutes`)

- [ ] **Step 1: Write it**

```ts
import { SUPPORTED_MCP_PROTOCOL_VERSIONS, LATEST_MCP_PROTOCOL_VERSION } from '../services/mcpProtocol';

const TOOLS = [
  { name: 'query_devices', description: 'd', input_schema: { type: 'object', properties: {} } },
  { name: 'manage_services', description: 'd', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'restart'] } } } },
];

describe.each([...SUPPORTED_MCP_PROTOCOL_VERSIONS])('MCP conformance for protocol %s', (version) => {
  beforeEach(() => {
    mocks.getToolDefinitions.mockReturnValue(TOOLS);
    mocks.getToolTier.mockImplementation((n: string) => (n === 'manage_services' ? 2 : 1));
    mocks.executeTool.mockResolvedValue(JSON.stringify({ ok: true }));
  });

  async function session() {
    const app = appWithMcpRoutes();
    const init = await app.request('/mcp/sse', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '0' } } }) });
    const body = await init.json();
    const sid = init.headers.get('Mcp-Session-Id')!;
    const rpc = async (method: string, params?: unknown, id = 2) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': 'k', 'Mcp-Session-Id': sid };
      if (version !== '2024-11-05') headers['MCP-Protocol-Version'] = version;   // header exists from 2025-06-18; harmless earlier
      const res = await app.request('/mcp/sse', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      return { status: res.status, body: await res.json() };
    };
    return { init: body, rpc };
  }

  it('initialize echoes the requested version and reports server identity', async () => {
    const { init } = await session();
    expect(init.result.protocolVersion).toBe(version);
    expect(init.result.serverInfo).toMatchObject({ name: 'breeze-rmm', title: 'Breeze RMM', version: expect.any(String) });
    expect(init.result.capabilities.tools).toEqual({ listChanged: false });
  });

  it('tools/list is sorted and every tool carries name, description, inputSchema, title, annotations, _meta', async () => {
    const { rpc } = await session();
    const { body } = await rpc('tools/list');
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
    for (const t of body.result.tools) {
      expect(Object.keys(t).sort()).toEqual(['_meta', 'annotations', 'description', 'inputSchema', 'name', 'title']);
      expect(Object.keys(t.annotations).sort()).toEqual(['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint']);
    }
  });

  it('tools/call returns a text block and matching structuredContent', async () => {
    const { rpc } = await session();
    const { body } = await rpc('tools/call', { name: 'query_devices', arguments: {} });
    expect(body.result.content[0].type).toBe('text');
    expect(body.result.structuredContent).toEqual(JSON.parse(body.result.content[0].text));
  });

  it('unknown methods are -32601 and the deny paths are unchanged (tier-3 action is refused)', async () => {
    const { rpc } = await session();
    expect((await rpc('nope')).body.error.code).toBe(-32601);
    const { body } = await rpc('tools/call', { name: 'manage_services', arguments: { action: 'restart' } });
    expect(body.result.isError).toBe(true);
  });
});

describe('MCP conformance — negotiation edge cases', () => {
  it('an unsupported requested version gets the latest supported one', async () => {
    const app = appWithMcpRoutes();
    const init = await app.request('/mcp/sse', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28' } }) });
    expect((await init.json()).result.protocolVersion).toBe(LATEST_MCP_PROTOCOL_VERSION);
  });
  it('an unsupported MCP-Protocol-Version header on a later request is a 400 with -32600', async () => {
    const app = appWithMcpRoutes();
    const init = await app.request('/mcp/sse', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
    const res = await app.request('/mcp/sse', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': 'k', 'Mcp-Session-Id': init.headers.get('Mcp-Session-Id')!, 'MCP-Protocol-Version': '1999-01-01' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
  });
});
```

The tier-3 deny assertion relies on `manage_services.restart` being in `TIER3_ACTIONS` (`aiGuardrails.ts:216`) and on the file mocking `../services/aiTools` but **not** `../services/aiGuardrails` — check the copied preamble; if guardrails are mocked there, unmock them for this file.

- [ ] **Step 2: Verify and commit**

```bash
cd apps/api && npx vitest run src/routes/mcpServer.conformance.contract.test.ts
git add apps/api/src/routes && git commit -m "test(mcp): per-version conformance contract (B-W01)"
```

---

### Task 8: Verification and PR

- [ ] **Step 1:**

```bash
cd apps/api && npx vitest run src/routes/mcpServer      # expect ≥ 18 files
cd apps/api && npx vitest run && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json && pnpm lint
cd apps/docs && pnpm astro check
```

- [ ] **Step 2: Live check on a stack** (`pnpm wt-stack up`, an API key with `ai:read`):

```bash
curl -s -X POST "$API/api/v1/mcp/sse" -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' -D - | tee /tmp/init.txt
SID=$(grep -i '^Mcp-Session-Id:' /tmp/init.txt | awk '{print $2}' | tr -d '\r')
curl -s -X POST "$API/api/v1/mcp/sse" -H "Content-Type: application/json" -H "X-API-Key: $KEY" -H "Mcp-Session-Id: $SID" -H "MCP-Protocol-Version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq '.result.tools | length, (.[0] | {name,title,annotations,_meta})'
# and once with the real Claude Code client:
claude mcp add --transport http breeze-local "$API/api/v1/mcp/sse" --header "X-API-Key: $KEY" && claude mcp list
```

Record the `tools/list` byte size for an `ai:read` key in the A-W01 baseline doc §6 ("external tools/list bytes") — it grows slightly this wave (annotations); B-W02 is what shrinks it.

- [ ] **Step 3: PR** — branch `feature/6154-mcp-modernization/wave-6155`, `Closes #6155`; body lists the negotiation matrix, the annotation rule, the pagination default and why, the live-check output, and "no auth/session changes". One review round. Tear the stack down (`pnpm wt-stack down`).

---

## Self-review against the spec / #6143 W1

- Version negotiation (`2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`) → Tasks 1, 2 (spec named three; `2025-03-26` is the revision that introduced negotiation and is the header-absent default, so it is in the set).
- Annotations + `title` generated from tier/`TIER3_ACTIONS` and A-W02 metadata → Task 3 (+ `_meta` domain).
- Real `serverInfo.version` → Task 2.
- Deterministic order → Task 4.
- `tools/list` pagination → Task 4 (dormant by default; the reason is recorded).
- `structuredContent` beside text → Task 5.
- Docs + `ai-agent` skill lead with Streamable HTTP → Task 6.
- Per-version conformance contract test → Task 7.
- `MCP-Protocol-Version` header read/validated (#6143 table row) → Task 2.
- Principle 4 (tool never weaker than its route) → annotations never looser than guardrails (Task 3 contract), deny paths untouched (Task 7 asserts).
