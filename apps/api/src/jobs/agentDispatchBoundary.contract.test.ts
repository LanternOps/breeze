// apps/api/src/jobs/agentDispatchBoundary.contract.test.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Wave 3.5b (#4084): BullMQ job modules may run in a worker-role process that
// holds NO agent sockets. Socket-local dispatch there silently reports every
// agent offline — the exact incident class this wave exists to prevent. Jobs
// must use dispatchCommandToAgent/isAgentConnectedAnywhere (agentCommandRelay).
const JOBS_DIR = fileURLToPath(new URL('.', import.meta.url));

// The relay consumer is the ONE legitimate socket-local caller under jobs/ —
// its registration is gated to socket-owning roles in index.ts.
const SOCKET_OWNER_ALLOWLIST = new Set(['agentCommandRelayWorker.ts']);

const FORBIDDEN_PATTERNS: Array<[string, RegExp]> = [
  ['value import of socket-local agentWs dispatch',
    /import\s+(?!type\s)\{[^}]*\b(sendCommandToAgent|isAgentConnected|disconnectAgent|broadcastToAgents)\b[^}]*\}\s*from\s*['"][^'"]*agentWs['"]/],
  ['value import of in-memory agentCommandAwait',
    /import\s+(?!type\s)\{[^}]*\bsendCommandToAgentAwaitResult\b[^}]*\}\s*from\s*['"][^'"]*agentCommandAwait['"]/],
];

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...productionSources(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('jobs/** must not use socket-local agent dispatch (#4084)', () => {
  const files = productionSources(JOBS_DIR)
    .filter((f) => !SOCKET_OWNER_ALLOWLIST.has(f.slice(JOBS_DIR.length)));

  it('found job modules to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [f.slice(JOBS_DIR.length), f]))('%s', (_label, full) => {
    const src = readFileSync(full, 'utf8');
    for (const [what, pattern] of FORBIDDEN_PATTERNS) {
      expect(src, `${what} — route through services/agentCommandRelay instead`).not.toMatch(pattern);
    }
  });
});
