# AI for Office — Multi-Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Excel-only "AI for Office" assistant into a multi-host platform (Excel · Word · PowerPoint · Outlook) where the server control plane and ~70% of the add-in are shared, and each host contributes only its tool layer.

**Architecture:** A logical `HostAdapter` seam already decouples the add-in core from `Excel.*` (`apps/office-addin/src/host/{types,excel}.ts`). This plan (1) makes the **server** host-aware — the tool registry, MCP server name, system prompt, and session `type` become keyed by host; (2) closes the two remaining host-bound leaks in the add-in core so the seam is airtight; (3) physically splits the add-in into a shared `packages/office-addin-core` + a host-bound `apps/excel-addin`; and (4) adds the first sibling host, `apps/word-addin`, proving the seam end-to-end.

**Tech Stack:** Hono + Drizzle + PostgreSQL (server), Claude Agent SDK (`createSdkMcpServer`/`tool`), React 19 + Vite + Office.js (add-in), Vitest (both sides).

**Worktree:** All work happens in `/Users/toddhebebrand/breeze-ai4office` (branch `feat/ai-for-office`). Prefix Node commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.

---

## Phased Roadmap & Sequencing

Four phases, sequenced **capability-first** (lowest-risk, highest-leverage work before the high-churn refactor):

| Phase | What | Risk | Why this order |
|---|---|---|---|
| **1. Server host-keying** | `host` param + per-host registry/prompt/`type`/MCP-name + migration | Low (additive) | Unblocks every future host; fully testable without touching the add-in. **Detailed below.** |
| **2. Adapter-leak cleanup** | Route `useSelectionAddress` + `QuickActions` capture through `HostAdapter` | Low | Makes the seam airtight before a 2nd host exists to fork it. **Detailed below.** |
| **3. Physical package split** | `packages/office-addin-core` + `apps/excel-addin` | High churn | Pure refactor, no behavior change. Outlined here; **gets its own detailed plan** before execution. |
| **4. Baseline Word adapter** | `apps/word-addin` + Word tools/prompt server-side | Medium | Proves the seam. Depends on Phase 3. Outlined here; **gets its own detailed plan** before execution. |

The logical `HostAdapter` seam already prevents core-**logic** drift, so Phases 1–2 deliver real multi-host capability before the cosmetic-but-large Phase 3 restructure. Phases 3 and 4 are deliberately left as roadmaps here (not bite-sized) because the exact edits firm up during execution and a speculative literal file-move plan would be brittle; each will be expanded into its own `docs/superpowers/plans/` doc when its turn comes.

---

## Phase 1 — Server Host-Keying (DETAILED)

### Design decisions (read first)

- **`ClientHost = 'excel' | 'word' | 'powerpoint' | 'outlook'`.** The session `type` column stores `` `${host}_client` `` (e.g. `excel_client`, `word_client`). No new DB column — host is encoded in `type` exactly as today.
- **Registry becomes a host map.** `CLIENT_TOOL_REGISTRIES: Record<ClientHost, Record<string, ClientWorkbookTool>>`. Only `excel` is populated in this phase; `word`/`powerpoint`/`outlook` are `{}` (populated in Phase 4+). A back-compat alias `CLIENT_TOOL_REGISTRY = CLIENT_TOOL_REGISTRIES.excel` is kept so unrelated code/tests don't churn.
- **"Supported host" guard.** `isClientHostSupported(host)` ⇔ that host's registry is non-empty. Creating a session for an unsupported host returns `400 unsupported_host`. This means we do **not** need real Word/PPT/Outlook prompts until their registries exist — only `excel` is creatable in this phase.
- **Everything generic stays generic.** The tool handler, DLP chokepoint, bridge, persistence, and audit are host-neutral and do not change except to thread `host` into the registry lookup.
- **`workbookName` column is NOT renamed** in this phase (avoid a column migration + churn). It already stores a free-text "document name" and is host-neutral enough; a rename is a deferred cleanup.

### File structure (Phase 1)

- Modify: `apps/api/src/services/clientAiTools.ts` — host map, host-keyed helpers, handler signature.
- Modify: `apps/api/src/services/clientAiSessions.ts` — `buildClientSystemPrompt(host, writeMode)`.
- Create: `apps/api/src/services/clientAiHosts.ts` — the small host vocabulary (`ClientHost`, `CLIENT_HOSTS`, `clientSessionType`, `clientHostFromType`, `CLIENT_SESSION_TYPES`).
- Modify: `apps/api/src/routes/clientAi/schemas.ts` — `host` on `createClientSessionSchema`.
- Modify: `apps/api/src/routes/clientAi/sessions.ts` — create handler, `ensureActiveClientSession`, the two `type` WHERE clauses, GET-history host filter.
- Modify: `apps/api/src/routes/clientAi/adminSessions.ts` — generalize the two `type` WHERE clauses to all client types.
- Create: `apps/api/migrations/2026-06-13-ai-for-office-host-keying.sql` — generalize the principal CHECK constraint.
- Modify: `apps/api/src/db/schema/ai.ts` — update the constraint comment.
- Test: `clientAiHosts.test.ts`, `clientAiTools.registry.test.ts` (update pins), `clientAiSessions.test.ts` (prompt-by-host), `schemas` host test, `sessions.*.test.ts` (host create + unsupported reject).

> **Note for the implementer:** the api suite is flaky in parallel — run client-ai tests single-fork: `pnpm --filter @breeze/api test -- --no-file-parallelism <file>`.

---

### Task 1: Host vocabulary module

**Files:**
- Create: `apps/api/src/services/clientAiHosts.ts`
- Test: `apps/api/src/services/clientAiHosts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import {
  CLIENT_HOSTS,
  CLIENT_SESSION_TYPES,
  clientSessionType,
  clientHostFromType,
  isClientHost,
} from './clientAiHosts';

describe('clientAiHosts', () => {
  it('enumerates the four supported Office hosts', () => {
    expect(CLIENT_HOSTS).toEqual(['excel', 'word', 'powerpoint', 'outlook']);
  });

  it('maps host -> session type and back', () => {
    expect(clientSessionType('excel')).toBe('excel_client');
    expect(clientSessionType('word')).toBe('word_client');
    expect(clientHostFromType('excel_client')).toBe('excel');
    expect(clientHostFromType('powerpoint_client')).toBe('powerpoint');
  });

  it('CLIENT_SESSION_TYPES is every host type', () => {
    expect(CLIENT_SESSION_TYPES).toEqual([
      'excel_client', 'word_client', 'powerpoint_client', 'outlook_client',
    ]);
  });

  it('returns null for non-client types', () => {
    expect(clientHostFromType('general')).toBeNull();
    expect(clientHostFromType('agent')).toBeNull();
  });

  it('isClientHost narrows unknown strings', () => {
    expect(isClientHost('excel')).toBe(true);
    expect(isClientHost('keynote')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test -- --no-file-parallelism src/services/clientAiHosts.test.ts`
Expected: FAIL — cannot find module `./clientAiHosts`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/clientAiHosts.ts
/**
 * AI for Office — the host vocabulary. The client surface runs inside one of
 * four Office hosts; a session's host is encoded in ai_sessions.type as
 * `${host}_client` (no separate column). Keep this list and the DB principal
 * CHECK constraint (migration 2026-06-13-d-ai-for-office-host-keying.sql) in sync.
 */
export const CLIENT_HOSTS = ['excel', 'word', 'powerpoint', 'outlook'] as const;
export type ClientHost = (typeof CLIENT_HOSTS)[number];

export function isClientHost(value: unknown): value is ClientHost {
  return typeof value === 'string' && (CLIENT_HOSTS as readonly string[]).includes(value);
}

/** host -> ai_sessions.type value, e.g. 'excel' -> 'excel_client'. */
export function clientSessionType(host: ClientHost): string {
  return `${host}_client`;
}

/** Every client session type, for "any client session" WHERE filters. */
export const CLIENT_SESSION_TYPES: string[] = CLIENT_HOSTS.map(clientSessionType);

/** ai_sessions.type -> host, or null when the row is not a client session. */
export function clientHostFromType(type: string): ClientHost | null {
  if (!type.endsWith('_client')) return null;
  const host = type.slice(0, -'_client'.length);
  return isClientHost(host) ? host : null;
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test -- --no-file-parallelism src/services/clientAiHosts.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/clientAiHosts.ts apps/api/src/services/clientAiHosts.test.ts
git commit -m "feat(client-ai): host vocabulary (ClientHost + session-type mapping)"
```

---

### Task 2: Host-keyed tool registry + MCP helpers

**Files:**
- Modify: `apps/api/src/services/clientAiTools.ts:52-296` (registry + the `CLIENT_MCP_*` exports + `clientMcpToolNamesForWriteMode`), `:452-568` (handler + server factory)
- Test: `apps/api/src/services/clientAiTools.registry.test.ts` (full migration — see Step 1)
- Test: `apps/api/src/services/clientAiTools.handler.test.ts` (7 call sites of `makeClientToolHandler` — see Step 4b)

- [ ] **Step 1: Migrate the WHOLE registry test to the host-keyed contract (failing)**

> ⚠️ The deleted constants are referenced throughout this file — migrating only the shown block leaves it broken. Apply EVERY substitution below so no deleted-constant reference survives:
> - `CLIENT_TOOL_NAMES` (lines ~45,49,54,63,69) → `clientToolNames('excel')`
> - `CLIENT_MCP_SERVER_NAME` (line ~75) → `clientMcpServerName('excel')`
> - `CLIENT_MCP_TOOL_PREFIX` (line ~76) → `clientMcpToolPrefix('excel')`
> - `CLIENT_MCP_TOOL_NAMES` (lines ~77,81) → `clientMcpToolNames('excel')`
> - `clientMcpToolNamesForWriteMode('readwrite'|'readonly')` (lines ~87,91) → add `'excel'` first arg
>
> After editing, grep the file for the old names: `grep -nE "CLIENT_TOOL_NAMES|CLIENT_MCP_SERVER_NAME|CLIENT_MCP_TOOL_PREFIX|CLIENT_MCP_TOOL_NAMES" apps/api/src/services/clientAiTools.registry.test.ts` must return ZERO hits.

Add these host-map assertions (replacing the old server-name/prefix/writeMode block):

```ts
import {
  CLIENT_TOOL_REGISTRIES,
  EXCEL_CLIENT_TOOL_REGISTRY,
  CLIENT_TOOL_REGISTRY,           // back-compat alias === EXCEL_CLIENT_TOOL_REGISTRY
  clientMcpServerName,
  clientMcpToolPrefix,
  clientToolNames,
  clientMcpToolNames,
  clientMcpToolNamesForWriteMode,
  isClientHostSupported,
} from './clientAiTools';

it('keeps the Excel registry as the only populated host (14 tools / 9 mutating)', () => {
  expect(Object.keys(EXCEL_CLIENT_TOOL_REGISTRY)).toHaveLength(14);
  expect(Object.values(EXCEL_CLIENT_TOOL_REGISTRY).filter((t) => t.mutating)).toHaveLength(9);
  expect(CLIENT_TOOL_REGISTRY).toBe(EXCEL_CLIENT_TOOL_REGISTRY);
});

it('word/powerpoint/outlook registries are empty (unsupported until built)', () => {
  expect(Object.keys(CLIENT_TOOL_REGISTRIES.word)).toHaveLength(0);
  expect(isClientHostSupported('excel')).toBe(true);
  expect(isClientHostSupported('word')).toBe(false);
});

it('MCP server name + prefix are host-keyed', () => {
  expect(clientMcpServerName('excel')).toBe('excel');
  expect(clientMcpToolPrefix('excel')).toBe('mcp__excel__');
  expect(clientMcpServerName('word')).toBe('word');
});

it('readwrite exposes all 14 excel tools; readonly strips the 9 mutating', () => {
  expect(clientMcpToolNamesForWriteMode('excel', 'readwrite')).toHaveLength(14);
  expect(clientMcpToolNamesForWriteMode('excel', 'readonly')).toHaveLength(5);
  for (const n of clientMcpToolNames('excel')) expect(n.startsWith('mcp__excel__')).toBe(true);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test -- --no-file-parallelism src/services/clientAiTools.registry.test.ts`
Expected: FAIL — missing exports `CLIENT_TOOL_REGISTRIES`, `clientMcpServerName`, etc.

- [ ] **Step 3: Implement the host map + helpers in `clientAiTools.ts`**

Rename the existing `CLIENT_TOOL_REGISTRY` object literal (the 14-tool block, lines 52-268) to `EXCEL_CLIENT_TOOL_REGISTRY`, then replace lines 270-297 with:

```ts
export type ClientToolName = keyof typeof EXCEL_CLIENT_TOOL_REGISTRY;

/** Per-host tool registries. Only Excel is populated today; Word/PowerPoint/
 *  Outlook are filled in as each host's tools land (Phase 4+). */
export const CLIENT_TOOL_REGISTRIES: Record<ClientHost, Record<string, ClientWorkbookTool>> = {
  excel: EXCEL_CLIENT_TOOL_REGISTRY,
  word: {},
  powerpoint: {},
  outlook: {},
};

/** Back-compat alias for code/tests that only ever meant the Excel registry. */
export const CLIENT_TOOL_REGISTRY = EXCEL_CLIENT_TOOL_REGISTRY;

export function isClientHostSupported(host: ClientHost): boolean {
  return Object.keys(CLIENT_TOOL_REGISTRIES[host]).length > 0;
}

/** MCP server name === host string ⇒ SDK tool prefix mcp__<host>__<tool>
 *  (own namespace, disjoint from mcp__breeze__). */
export function clientMcpServerName(host: ClientHost): string {
  return host;
}
export function clientMcpToolPrefix(host: ClientHost): string {
  return `mcp__${clientMcpServerName(host)}__`;
}

export function clientToolNames(host: ClientHost): string[] {
  return Object.keys(CLIENT_TOOL_REGISTRIES[host]);
}
export function clientMutatingToolNames(host: ClientHost): string[] {
  const reg = CLIENT_TOOL_REGISTRIES[host];
  return Object.keys(reg).filter((name) => reg[name].mutating);
}
export function clientMcpToolNames(host: ClientHost): string[] {
  return clientToolNames(host).map((name) => `${clientMcpToolPrefix(host)}${name}`);
}

/** SDK allowlist for a session: 'readonly' strips mutating tools at session
 *  start (the handler also rejects them server-side as defense-in-depth). */
export function clientMcpToolNamesForWriteMode(
  host: ClientHost,
  writeMode: 'readwrite' | 'readonly',
): string[] {
  const reg = CLIENT_TOOL_REGISTRIES[host];
  return Object.keys(reg)
    .filter((name) => writeMode === 'readwrite' || !reg[name].mutating)
    .map((name) => `${clientMcpToolPrefix(host)}${name}`);
}
```

Add the import at the top of `clientAiTools.ts`:

```ts
import { type ClientHost } from './clientAiHosts';
```

- [ ] **Step 4: Make the handler + server factory host-aware**

Change `makeClientToolHandler` (line 452) and `createClientWorkbookMcpServer` (line 555) to take `host`:

```ts
export function makeClientToolHandler(
  host: ClientHost,
  toolName: string,
  getSession: () => ActiveSession,
) {
  const entry: ClientWorkbookTool = CLIENT_TOOL_REGISTRIES[host][toolName];
  // ...rest of the body UNCHANGED (it already only reads `entry` + args)...
}

export function createClientWorkbookMcpServer(host: ClientHost, getSession: () => ActiveSession) {
  const reg = CLIENT_TOOL_REGISTRIES[host];
  return createSdkMcpServer({
    name: clientMcpServerName(host),
    version: '1.0.0',
    tools: Object.keys(reg).map((name) =>
      tool(name, reg[name].description, reg[name].inputSchema, makeClientToolHandler(host, name, getSession)),
    ),
  });
}
```

Delete the now-replaced module-level `CLIENT_MCP_SERVER_NAME`, `CLIENT_MCP_TOOL_PREFIX`, `CLIENT_MCP_TOOL_NAMES`, `CLIENT_TOOL_NAMES`, `CLIENT_MUTATING_TOOL_NAMES` constants (they were Excel-implicit). Grep first to find ALL callers: `grep -rn "CLIENT_MCP_SERVER_NAME\|CLIENT_MCP_TOOL_NAMES\|CLIENT_TOOL_NAMES\|CLIENT_MUTATING_TOOL_NAMES" apps/api/src` — expected hits: `sessions.ts` (updated in Task 4), `clientAiTools.registry.test.ts` (Step 1). The changed `makeClientToolHandler` signature additionally has callers in `clientAiTools.handler.test.ts` (Step 4b) — grep `grep -rn "makeClientToolHandler" apps/api/src` to confirm.

- [ ] **Step 4b: Update the 7 handler-test call sites**

`apps/api/src/services/clientAiTools.handler.test.ts` calls the OLD 2-arg `makeClientToolHandler('write_range', () => session)` at 7 sites (lines ~87,113,135,167,184,200,223). Update each to the 3-arg form with the Excel host:

```ts
const handler = makeClientToolHandler('excel', 'write_range', () => session);
// ...and likewise for the other tools (read_range, read_selection, ...) at each site.
```

After: `grep -nE "makeClientToolHandler\('(write_range|read_range|read_selection|[a-z_]+)', " apps/api/src/services/clientAiTools.handler.test.ts` must return ZERO old-style (2-arg) hits.

- [ ] **Step 5: Run the registry + handler tests, verify they pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test -- --no-file-parallelism src/services/clientAiTools.registry.test.ts src/services/clientAiTools.handler.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/clientAiTools.ts apps/api/src/services/clientAiTools.registry.test.ts apps/api/src/services/clientAiTools.handler.test.ts
git commit -m "feat(client-ai): host-keyed tool registry + MCP helpers (Excel populated)"
```

---

### Task 3: Host-keyed system prompt

**Files:**
- Modify: `apps/api/src/services/clientAiSessions.ts:26-53`
- Test: `apps/api/src/services/clientAiSessions.test.ts` — **APPEND** cases. This file ALREADY EXISTS (`:13-18` imports `EXCEL_CLIENT_SYSTEM_PROMPT, buildExcelClientSystemPrompt`; `:66-71` pin the full prompt content + readonly addendum). Do NOT `Write`/recreate it — those existing assertions must remain (the back-compat exports are retained).

- [ ] **Step 1: Append the failing test cases** (to the existing `clientAiSessions.test.ts`)

```ts
// add to the existing imports: buildClientSystemPrompt
import { buildClientSystemPrompt } from './clientAiSessions';

describe('buildClientSystemPrompt', () => {
  it('returns the Excel prompt for the excel host (readwrite)', () => {
    expect(buildClientSystemPrompt('excel', 'readwrite')).toBe(EXCEL_CLIENT_SYSTEM_PROMPT);
  });
  it('appends the read-only addendum under readonly', () => {
    const p = buildClientSystemPrompt('excel', 'readonly');
    expect(p.startsWith(EXCEL_CLIENT_SYSTEM_PROMPT)).toBe(true);
    expect(p).toContain('READ-ONLY');
  });
  it('throws fail-loud for a host with no prompt (e.g. word in Phase 1)', () => {
    expect(() => buildClientSystemPrompt('word', 'readwrite')).toThrow(/unsupported|no prompt/i);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test -- --no-file-parallelism src/services/clientAiSessions.test.ts`
Expected: FAIL — `buildClientSystemPrompt` is not exported.

- [ ] **Step 3: Implement**

Add to `clientAiSessions.ts`, keeping `EXCEL_CLIENT_SYSTEM_PROMPT`, `READONLY_ADDENDUM`, and `buildExcelClientSystemPrompt` as-is for back-compat:

```ts
import type { ClientHost } from './clientAiHosts';

/** Host-keyed system prompts. Only Excel has a prompt today; a host is
 *  "supported" only when it has BOTH a non-empty tool registry
 *  (isClientHostSupported) AND a prompt here — Phase 4 adds Word to both. */
const CLIENT_SYSTEM_PROMPTS: Partial<Record<ClientHost, string>> = {
  excel: EXCEL_CLIENT_SYSTEM_PROMPT,
};

export function buildClientSystemPrompt(host: ClientHost, writeMode: 'readwrite' | 'readonly'): string {
  const base = CLIENT_SYSTEM_PROMPTS[host];
  // Fail-loud: an unsupported host must never reach prompt-building (the
  // create-session route guards with isClientHostSupported; the use path
  // guards in ensureActiveClientSession). No generic fallback — we never ship
  // an untested half-baked prompt.
  if (!base) throw new Error(`No client system prompt for unsupported host: ${host}`);
  return writeMode === 'readonly' ? base + READONLY_ADDENDUM : base;
}
```

- [ ] **Step 4: Run it, verify it passes** — same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/clientAiSessions.ts apps/api/src/services/clientAiSessions.test.ts
git commit -m "feat(client-ai): host-keyed system prompt builder"
```

---

### Task 4: Thread host through the session routes

**Files:**
- Modify: `apps/api/src/routes/clientAi/schemas.ts:156-160`
- Modify: `apps/api/src/routes/clientAi/sessions.ts` (create handler `:198-264`, `ensureActiveClientSession` `:137-192`, WHERE clauses `:80` and `:296`)
- Modify: `apps/api/src/routes/clientAi/adminSessions.ts:85,145`
- Test: `apps/api/src/routes/clientAi/sessions.create.test.ts` (new), and update existing `sessions.*.test.ts` only if a signature they call changed.

- [ ] **Step 1: Add `host` to the create-session schema (with test)**

In `schemas.ts`:

```ts
import { CLIENT_HOSTS } from '../../services/clientAiHosts';

export const createClientSessionSchema = z
  .object({
    workbookName: z.string().trim().min(1).max(500).optional(),
    host: z.enum(CLIENT_HOSTS).optional().default('excel'),
  })
  .strict();
```

Schema test (in the nearest schemas test file, or a new `schemas.test.ts`):

```ts
it('defaults host to excel and rejects unknown hosts', () => {
  expect(createClientSessionSchema.parse({}).host).toBe('excel');
  expect(createClientSessionSchema.safeParse({ host: 'keynote' }).success).toBe(false);
});
```

- [ ] **Step 2: Update the create handler**

In `sessions.ts` create handler, replace lines ~215-251:

```ts
import { isClientHostSupported, clientMcpServerName } from '../../services/clientAiTools';
import { clientSessionType } from '../../services/clientAiHosts';
import { buildClientSystemPrompt } from '../../services/clientAiSessions';

  const { workbookName, host } = parsed.data;

  const rejection = await runClientPreflight(c, auth, policy);
  if (rejection) return rejection;

  if (!isClientHostSupported(host)) {
    return c.json({ error: 'unsupported_host', host }, 400);
  }

  const model = policy.allowedModels[0] ?? DEFAULT_CLIENT_AI_MODEL;
  const systemPrompt = buildClientSystemPrompt(host, policy.writeMode);

  const [session] = await db
    .insert(aiSessions)
    .values({
      orgId: auth.orgId,
      userId: null,
      clientUserId: auth.clientUserId,
      type: clientSessionType(host),
      model,
      systemPrompt,
      workbookName: workbookName ?? null,
    })
    .returning({ id: aiSessions.id });
```

Add `host` to the create audit `details` and (optional) the 201 response body.

- [ ] **Step 3: Make `ensureActiveClientSession` host-aware (with a fail-loud use-path guard)**

The session's host comes from its stored `type`. `ClientSessionRow` is `typeof aiSessions.$inferSelect` and `loadClientSession` uses a full `.select()` (no projection), so `sessionRow.type` is ALWAYS present — no schema/select change is needed, only the new computation lines.

The create route 400s an unsupported host, but `loadClientSession` widens to `inArray(type, CLIENT_SESSION_TYPES)` (Step 4) and could load a `word_client` row whose registry is empty — that would silently build a zero-tools MCP server. Guard the use path symmetrically so it fails loud instead:

```ts
import { clientHostFromType } from '../../services/clientAiHosts';
import { createClientWorkbookMcpServer, clientMcpToolNamesForWriteMode, clientMcpServerName, isClientHostSupported } from '../../services/clientAiTools';
import { buildClientSystemPrompt } from '../../services/clientAiSessions';

  const host = clientHostFromType(sessionRow.type);
  if (!host || !isClientHostSupported(host)) {
    // A stored session whose host has no tools (e.g. a future word_client row
    // in Phase 1) must not spin up an empty-tools session. Caller maps this to
    // a 400/409; never hand the model a zero-tool registry.
    throw new ClientHostUnsupportedError(sessionRow.type);
  }
  // ...
    sessionRow.systemPrompt ?? buildClientSystemPrompt(host, policy.writeMode),
    maxBudgetUsd,
    clientMcpToolNamesForWriteMode(host, policy.writeMode),
    (_getAuth, _onPreToolUse, _onPostToolUse, getSession) => ({
      server: createClientWorkbookMcpServer(host, getSession),
      name: clientMcpServerName(host),
    }),
```

Define `ClientHostUnsupportedError` (a small `class extends Error`) near the top of `sessions.ts` and catch it in the message/events handlers that call `ensureActiveClientSession`, returning `c.json({ error: 'unsupported_host' }, 400)`. Add a test asserting a stored `word_client` row cannot start a session in Phase 1.

- [ ] **Step 4: Generalize the session WHERE clauses**

- `sessions.ts:80` (loadClientSession, single session by id): `eq(aiSessions.type, 'excel_client')` → `inArray(aiSessions.type, CLIENT_SESSION_TYPES)` (any of the user's client sessions; tenancy already pinned by clientUserId+orgId).
- `sessions.ts:296` (GET history list): make host-scoped. Add an optional `host` query param **validated through `z.enum(CLIENT_HOSTS)`** (default `'excel'`; return `400` on an out-of-vocab value, matching the create path — do NOT silently return an empty list) and filter `eq(aiSessions.type, clientSessionType(host))` so each host's pane shows its own threads.
- `adminSessions.ts:85,145`: `eq(aiSessions.type, 'excel_client')` → `inArray(aiSessions.type, CLIENT_SESSION_TYPES)` so the admin dashboard shows client sessions across all hosts.

Add `import { inArray } from 'drizzle-orm';` and `import { CLIENT_SESSION_TYPES, clientSessionType } from '../../services/clientAiHosts';` where needed.

- [ ] **Step 5: Add the create-host route test**

```ts
// sessions.create.test.ts — mirror the existing sessions.*.test.ts harness/mocks
it('creates an excel_client session by default', async () => {
  const res = await app.request('/sessions', { method: 'POST', body: JSON.stringify({}) , headers });
  expect(res.status).toBe(201);
  // assert the insert used type 'excel_client' via the drizzle mock spy
});
it('rejects an unsupported host with 400', async () => {
  const res = await app.request('/sessions', { method: 'POST', body: JSON.stringify({ host: 'word' }), headers });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe('unsupported_host');
});
```

- [ ] **Step 6: Run the client-ai route + service tests**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test -- --no-file-parallelism src/routes/clientAi src/services/clientAiTools.registry.test.ts src/services/clientAiHosts.test.ts src/services/clientAiSessions.test.ts`
Expected: PASS (existing `type:'excel_client'` mock rows still match `inArray`/excel default).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/clientAi
git commit -m "feat(client-ai): thread host through create/load/list/admin session routes"
```

---

### Task 5: Generalize the principal CHECK constraint (migration)

**Files:**
- Create: `apps/api/migrations/2026-06-13-d-ai-for-office-host-keying.sql` (the `-d-` infix follows the same-day ordering convention — the existing day-13 files use `-a-`/`-b-`/`-c-`; an un-infixed `ai-...` name mis-sorts between `-a-` and `-b-` because `i`(0x69) > `-`(0x2D))
- Modify: `apps/api/src/db/schema/ai.ts:50-52` (comment only)

The shipped constraint `ai_sessions_excel_client_principal_check` is `CHECK (type <> 'excel_client' OR client_user_id IS NOT NULL)`. Generalize it to every client type. **Fix forward** — never edit the shipped migration.

- [ ] **Step 1: Write the migration**

```sql
-- 2026-06-13-d-ai-for-office-host-keying.sql
-- AI for Office multi-host: a client session's host is encoded in
-- ai_sessions.type as `${host}_client`. Generalize the excel-only principal
-- CHECK so EVERY client session type requires a client principal. Idempotent;
-- fix-forward replacement of ai_sessions_excel_client_principal_check.
-- conrelid-scoped lookups mirror the foundation migration (2026-06-12-b) — a
-- constraint name is unique per-table, not globally.
DO $$
BEGIN
  -- Drop the old excel-only constraint if it is still present.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_sessions_excel_client_principal_check'
      AND conrelid = 'ai_sessions'::regclass
  ) THEN
    ALTER TABLE ai_sessions DROP CONSTRAINT ai_sessions_excel_client_principal_check;
  END IF;
  -- Add the generalized constraint once.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_sessions_client_principal_check'
      AND conrelid = 'ai_sessions'::regclass
  ) THEN
    ALTER TABLE ai_sessions
      ADD CONSTRAINT ai_sessions_client_principal_check
      CHECK (
        type NOT IN ('excel_client', 'word_client', 'powerpoint_client', 'outlook_client')
        OR client_user_id IS NOT NULL
      );
  END IF;
END $$;
```

- [ ] **Step 2: Update the schema comment** in `ai.ts` (lines 50-52) to name `ai_sessions_client_principal_check` and the `${host}_client` convention.

- [ ] **Step 3: Verify migration ordering + drift**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test -- --no-file-parallelism src/db/autoMigrate.test.ts`
Then with a DB: `pnpm db:check-drift`.
Expected: ordering test PASS; no drift.

- [ ] **Step 4: Verify the constraint as `breeze_app` (manual, needs DB)**

`docker exec -it breeze-postgres psql -U breeze_app -d breeze` then attempt `INSERT INTO ai_sessions (org_id, type) VALUES ('<org>','word_client');` — must fail the new CHECK (no client principal). Document the result.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-13-d-ai-for-office-host-keying.sql apps/api/src/db/schema/ai.ts
git commit -m "feat(client-ai): generalize ai_sessions principal CHECK to all client hosts"
```

---

### Task 6: Host-aware bridge timeout message + full-suite check

**Files:**
- Modify: `apps/api/src/services/clientAiToolBridge.ts:59`

- [ ] **Step 1:** Change the timeout error from "...closed Excel..." to host-neutral: "...closed the document or not responded to the approval prompt." (The bridge has no host handle; a generic noun is correct and avoids threading host purely for a string.)

- [ ] **Step 2: Run the whole client-ai surface once**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api test -- --no-file-parallelism src/services/clientAi src/routes/clientAi`
Expected: PASS.

- [ ] **Step 3: Type-check**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no NEW errors (pre-existing `agents.test.ts`/`apiKeyAuth.test.ts` errors are known — see CLAUDE.md).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/clientAiToolBridge.ts
git commit -m "chore(client-ai): host-neutral bridge timeout message"
```

**Phase 1 done when:** the add-in (still sending no `host`, or `host:'excel'`) behaves identically, the server stores `excel_client` and is ready to accept `word_client` the moment a Word registry exists, and a `word`/`powerpoint`/`outlook` create returns `400 unsupported_host`.

---

## Phase 2 — Adapter-Leak Cleanup (DETAILED)

Two host-bound usages bypass the `HostAdapter` today; close them so the core never touches `Excel.*`. **Scope note:** "host-clean" here means no `Excel.*` host-APP coupling. `Office.onReady` (`main.tsx`) and `OfficeRuntime.auth.getAccessToken` (`auth/entraToken.ts`) are cross-host **Office-platform** APIs — they are legitimately host-neutral and STAY (they move into the core in Phase 3). The grep-gate targets `Excel.*`, not all of Office.js.

### File structure
> **Post-Phase-3 path note:** these files were authored under `apps/office-addin/src/` and have since moved in the package split — host-neutral ones to `packages/office-addin-core/src/`, host-bound ones to `apps/excel-addin/src/`. The new locations are reflected below.

- Modify: `packages/office-addin-core/src/host/types.ts` — add `captureSelectionAddress` and `subscribeSelectionChanged` to `HostAdapter` (BOTH **required** — see why below).
- Modify: `apps/excel-addin/src/host/excel.ts` — implement both members, wired to selection logic moved into an Excel module.
- Create: `apps/excel-addin/src/host/excelSelection.ts` — move the `Excel.run`/`Office.context.document.addHandlerAsync(DocumentSelectionChanged,…)` logic out of `hooks/useSelectionAddress.ts`.
- Modify: `packages/office-addin-core/src/hooks/useSelectionAddress.ts` — becomes a host-neutral hook taking injected `{ captureSelectionAddress, subscribeSelectionChanged }`; no direct `Excel.*`/`Office.context`.
- Modify: `packages/office-addin-core/src/components/QuickActions.tsx` — make `capture` a **required prop** (remove the host-bound default `capture = captureWorkbookContext.bind(null,'selection')` + the `../chat/captureContext` import).
- Modify: `packages/office-addin-core/src/components/Composer.tsx` — accept the selection fn(s) as props instead of importing the hook's Excel binding directly.
- Modify: `apps/excel-addin/src/components/ChatPane.tsx` — the prop source: thread `excelHostAdapter.captureContext.bind(null,'selection')` to QuickActions and `{ captureSelectionAddress, subscribeSelectionChanged }` (from `excelHostAdapter`) to Composer. **ChatPane keeps the sole `excelHostAdapter` import until Phase 3 hoists host selection to `App.tsx` — acceptable, call it out so reviewers don't expect ChatPane to be host-clean yet.**
- Test (UPDATE, exists): `packages/office-addin-core/src/chat/chatController.test.ts` — the inline `fakeHost` literal (`:166`) must add `captureSelectionAddress: async () => undefined` and `subscribeSelectionChanged: () => () => {}` (adding required members breaks this structural type otherwise).
- Test (UPDATE, exists): `apps/excel-addin/src/host/excel.test.ts` — add `typeof adapter.captureSelectionAddress === 'function'` + `subscribeSelectionChanged` to the `satisfies HostAdapter` shape assertions.
- Test (UPDATE, exists): `packages/office-addin-core/src/components/QuickActions.test.tsx` — ALREADY injects a `capture` fake in every case; only minor (the prop is now required, no behavior change).
- Test (CREATE): `packages/office-addin-core/src/hooks/useSelectionAddress.test.ts` — render the hook with injected fakes; assert it reads once on mount AND re-reads when a simulated `subscribeSelectionChanged` callback fires.
- Test (CREATE): `packages/office-addin-core/src/components/Composer.test.tsx` — Composer now takes selection props; cover render + the prop wiring.
- Mock: `apps/excel-addin/src/__tests__/officeMock.ts` — add `removeHandlerAsync` (currently only `addHandlerAsync` at `:914-924`), or document that the unsubscribe is a deliberate no-op.

### Why both members are REQUIRED (not optional)
The current `useSelectionAddress` keeps a LIVE `Office.context.document.addHandlerAsync(DocumentSelectionChanged, refresh)` subscription that re-reads the address on every selection change (intentionally never removed — the always-mounted Composer + a `disposed` flag guards late `setState`). A one-shot `captureSelectionAddress()` alone would LOSE the live refresh and the selection chip would freeze — a regression. So `subscribeSelectionChanged(cb): () => void` is a required contract member; the Excel impl returns a no-op unsubscribe to preserve the never-remove behavior. The hook rhythm: call `captureSelectionAddress()` once on mount, then again inside each `subscribeSelectionChanged` callback.

### Tasks (TDD, same rhythm as Phase 1)
1. **Extend `HostAdapter`** with required `captureSelectionAddress(): Promise<string | undefined>` and `subscribeSelectionChanged(cb: () => void): () => void`. Update the two existing test-fakes that `satisfies`/structurally match `HostAdapter` IN THE SAME COMMIT: `chat/chatController.test.ts:166` `fakeHost` and `host/excel.test.ts`. (Compile gate: `pnpm --filter @breeze/office-addin exec tsc --noEmit` is clean.)
2. **Move Excel selection logic** to `host/excelSelection.ts` + implement the two new adapter members in `host/excel.ts`. Rewrite `hooks/useSelectionAddress.ts` as a host-neutral hook over injected fns. CREATE `hooks/useSelectionAddress.test.ts` (mount-read + re-read-on-change with fakes). Add `removeHandlerAsync` to `officeMock.ts`.
3. **Thread props from ChatPane** to `QuickActions` (required `capture`) and `Composer` (selection fns), removing the host-bound default import in `QuickActions.tsx`. Update `QuickActions.test.tsx` (prop now required), CREATE `Composer.test.tsx`.
4. **Grep gate:** `grep -rn "Excel\.\|Office\.context" apps/office-addin/src/components apps/office-addin/src/hooks apps/office-addin/src/chat/chatController.ts apps/office-addin/src/approval/approvalStore.ts` returns **zero** hits (note: `OfficeRuntime`/`Office.onReady` are host-neutral platform APIs and out of scope). Commit.

> This phase has no server changes and no migration. Run `pnpm --filter @breeze/office-addin test` after each task.

---

## Phase 3 — Physical Package Split (ROADMAP — expand into its own plan before executing)

> **DONE (2026-06-13):** Phase 3 is complete — the split shipped per `docs/superpowers/plans/ai-mcp/2026-06-13-ai-for-office-phase3-package-split.md`. `apps/office-addin` was renamed to `apps/excel-addin` and the host-neutral core extracted to `packages/office-addin-core`. The roadmap below is retained as the original design record.

**Goal:** `packages/office-addin-core` (host-neutral, depends only on React + the wire types) imported by `apps/excel-addin` (host-bound: `tools/*`, `host/excel*.ts`, `approval/buildPreview.ts`, `chat/captureContext.ts`, manifest, vite). Renames `apps/office-addin` → `apps/excel-addin`.

**Move to `packages/office-addin-core/src`:** `api/*`, `auth/*`, `lib/*`, `approval/approvalStore.ts`, `chat/chatController.ts`, `chat/quickActions.ts`, `host/types.ts`, and host-neutral `components/*` (everything except `QuickActions`/`Composer` if they stay Excel-coupled — after Phase 2 they should be neutral and movable). Plus the host-neutral tests + `__tests__/setup.ts`. **Note:** `auth/entraToken.ts` references `OfficeRuntime.auth` — that is a cross-host Office-platform API, so it is correctly host-neutral and belongs in the core (it is NOT `Excel.*` coupling).

**Stay in `apps/excel-addin/src`:** `tools/*`, `host/excel.ts` + `host/excelSelection.ts`, `approval/buildPreview.ts`, `chat/captureContext.ts`, the Excel-specific tests, `__tests__/officeMock.ts`, `manifest.template.xml`, `scripts/*`, `vite.config.ts`, `taskpane.html`, `main.tsx`/`App.tsx`/`config.ts`.

**Mechanics to detail in the sub-plan:** new `packages/office-addin-core/package.json` (`@breeze/office-addin-core`, exports map, peerDep React, its own `vitest.config.ts` + `tsconfig`); add it as a workspace dep of `apps/excel-addin`; rewrite imports (`../api/client` → `@breeze/office-addin-core`); split the Vitest setup (core tests don't need `officeMock`); update root `pnpm-workspace.yaml`/`tsconfig` references and any CI path filters; keep the `@breeze/office-addin` package name as a deprecated alias or update all references. **Risk:** import-path churn across ~40 files and merge conflicts on the shared files listed in the `client-ai` skill — do it as one focused branch, no parallel lanes.

**Done when:** `pnpm --filter @breeze/office-addin-core test` and `pnpm --filter @breeze/excel-addin test` both pass, `pnpm --filter @breeze/excel-addin build` produces a working manifest, and `packages/office-addin-core` has zero `Excel.*`/`Office.context` references.

---

## Phase 4 — Baseline Word Adapter (ROADMAP — depends on Phase 3; own plan before executing)

**Goal:** prove the seam with a real second host. Minimal Word tool set (no full parity): `get_document_overview` (read), `read_selection`, `insert_text` (mutating), `format_text` (mutating), `find_replace` (mutating).

**Server (Phase-1 machinery makes this additive):**
- Populate `CLIENT_TOOL_REGISTRIES.word` in `clientAiTools.ts` with the Word tools' `inputSchema` (raw zod shapes) — `isClientHostSupported('word')` flips to `true`, so `host:'word'` sessions become creatable automatically.
- Add `CLIENT_SYSTEM_PROMPTS.word` (a real Word prompt) in `clientAiSessions.ts`.
- Bump the registry test's per-host counts.

**Add-in (`apps/word-addin`):** scaffold mirroring `apps/excel-addin`; depends on `@breeze/office-addin-core`. Provide a Word `HostAdapter` (`host/word.ts`): `toolExecutors` (Word.run-based), `mutatingTools`, `buildPreview` (a draft-diff/summary card), `captureContext` (selection/whole-doc), `captureSelectionAddress`, `captureName`. Add `manifest.template.xml` (Host `Document`) + a Word `officeMock`.

**Done when:** an end-to-end Word session creates (`host:'word'`), the model sees `mcp__word__*` tools, a mutating Word tool round-trips through the bridge → preview card → Apply, and `pnpm --filter @breeze/word-addin test` passes. Update `apps/*/README` + `FOLLOWUPS.md` + the `client-ai` skill.

---

## Self-Review (Phase 1)

- **Spec coverage:** every "host-coupling point" from the server inventory is addressed — registry (Task 2), MCP name/prefix (Task 2), system prompt (Task 3), `type` writes/reads (Tasks 4), create schema (Task 4), MCP factory + tool filter (Task 4), CHECK constraint (Task 5), bridge message (Task 6). ✔
- **Type consistency:** `ClientHost`, `clientSessionType`, `clientHostFromType`, `clientMcpServerName`, `clientMcpToolNamesForWriteMode(host, writeMode)`, `createClientWorkbookMcpServer(host, getSession)`, `makeClientToolHandler(host, toolName, getSession)`, `isClientHostSupported(host)`, `buildClientSystemPrompt(host, writeMode)` — names used identically across Tasks 1–6. ✔
- **No placeholders:** every code step shows the actual code; commands have expected output. ✔
- **Back-compat:** `CLIENT_TOOL_REGISTRY`, `EXCEL_CLIENT_SYSTEM_PROMPT`, `buildExcelClientSystemPrompt` retained so unrelated code/tests don't churn; the add-in keeps working with no `host` field (defaults to `excel`). ✔
