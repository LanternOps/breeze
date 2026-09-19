import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'fs';
import path from 'path';

// ============================================================================
// #5022 W01 — AI device dispatch is attributable BY CONSTRUCTION.
//
// Two source scans, not a review checklist. The cascade-registration history in
// this repo is contract tests 5/5, code review 0/5; this class of omission
// ("the new tool forgot to pass the origin") has exactly the same shape.
//
// Template: agentEditionCompat.test.ts's recursive walk + regex + hand-
// maintained allowlist + a non-empty-scan sanity assertion, so an empty walk
// can never read green.
// ============================================================================

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCAN_ROOTS = ['apps/api/src', 'ee'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = SCAN_ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root))).map((file) =>
  path.relative(REPO_ROOT, file),
);

// The ONLY files permitted to insert into device_commands or script_executions.
// Adding a file here is a deliberate act: it makes that file a chokepoint, and
// the chokepoint must stamp aiOriginColumns(...) or AI work goes unattributed.
const INSERT_CHOKEPOINTS = new Set([
  'apps/api/src/services/commandQueue.ts',
  // The transaction-scoped half, split out of commandQueue.ts purely so that
  // peripheralPolicyState.ts can reach it without dragging routes/agentWs.ts
  // into two worker closures — see its header and workerEntrypointClosure.
  'apps/api/src/services/commandQueueInsert.ts',
  'apps/api/src/services/scriptDispatch.ts',
]);

// Non-AI insert sites that pre-date W01. FROZEN BASELINE, never extended: each
// is a human- or system-initiated lane that has always written its own row, and
// none of them is reachable from an AI surface, so none can produce an
// unattributed AI dispatch. A NEW entry here would be a new way for AI work to
// reach a device without an origin -- route it through the chokepoints instead.
//
// (The two entries the W01 plan predicted -- aiToolsBrowser.ts and
// peripheralPolicyState.ts -- WERE converted and are deliberately absent. The
// plan's claim that those were the only two on main was wrong; these five are
// the rest, and they are out of W01's scope because they are not AI lanes.)
const PRE_EXISTING_NON_AI_INSERTS = new Set([
  'apps/api/src/routes/admin/abuse.ts', // abuse suspension fan-out (self_uninstall)
  'apps/api/src/routes/agents/helpers.ts', // agent enrolment / heartbeat-side rows
  'apps/api/src/routes/devices/actuateElevation.ts', // PAM actuation, human-approved
  'apps/api/src/routes/mobile.ts', // mobile app device actions, human-initiated
  'apps/api/src/services/desktopSessionStop.ts', // remote-desktop teardown, system-initiated
  'apps/api/src/services/wakeOnLan.ts', // WoL relay fan-out, system-initiated
  'apps/api/src/services/deviceUninstallDrain.ts', // uninstall drain, system-initiated
  'apps/api/src/services/scriptExecution.ts', // the human POST /scripts/:id/execute route
  'apps/api/src/services/tenantOffboarding.ts', // offboarding fan-out, system-initiated
]);

// AI code must reach the device through services/aiDispatch.ts, whose
// signatures make aiOrigin mandatory.
const RAW_DISPATCH =
  /\b(?:queueCommand|queueCommandForExecution|executeCommand|executeCommandWithSystemPrecheck|dispatchDeviceCommand|dispatchScriptToDevice|insertQueuedCommandInTransaction)\b/;
const AI_FILE = /^apps\/api\/src\/services\/(aiTools[^/]*\.ts|aiAgents\/.*\.ts)$/;

const AI_RAW_DISPATCH_ALLOWED = new Set<string>([
  // The adapter itself — it is what makes the origin mandatory.
  'apps/api/src/services/aiDispatch.ts',
]);

// Files that reach the command queue through a LAZY `await import(...)` rather
// than a static import, to break a module cycle. Each is allowlisted only
// because it has been read and verified to pass an `aiOrigin` at every
// dispatch site; the entry is a claim about that file, not a waiver.
const AI_LAZY_DISPATCH_ALLOWED = new Map<string, string>([
  [
    'apps/api/src/services/aiAgents/actVerify.ts',
    'derives { kind: ai_agent, agentRunId: run.id } at each executeCommandWithSystemPrecheck site (runAiOrigin)',
  ],
  [
    'apps/api/src/services/aiAgents/playbookActExecutor.ts',
    'passes agentAuth.aiOrigin into the service_status read',
  ],
  [
    'apps/api/src/services/aiToolsScripts.ts',
    'lazy-imports commandQueue only for CommandTypes / waitForCommandResult; every dispatch goes through aiDispatch',
  ],
]);

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

describe('AI device dispatch is attributable by construction (#5022 W01)', () => {
  it('scans a non-empty file set', () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it('sees at least one AI file, so the AI_FILE pattern cannot rot silently', () => {
    expect(FILES.filter((f) => AI_FILE.test(f)).length).toBeGreaterThan(10);
  });

  it('no file outside the chokepoints inserts into device_commands or script_executions', () => {
    const re = /\b(?:db|tx|trx|client)\s*\.\s*insert\s*\(\s*(deviceCommands|scriptExecutions)\b/;
    const offenders = FILES.filter(
      (f) => !INSERT_CHOKEPOINTS.has(f) && !PRE_EXISTING_NON_AI_INSERTS.has(f) && re.test(read(f)),
    );

    expect(
      offenders,
      'A hand-rolled insert bypasses the aiOrigin stamping AND resolveCommandCreatedBy. '
        + 'Use services/aiDispatch.ts (AI code) or commandQueue.insertQueuedCommandInTransaction. '
        + 'The two AI-reachable ones on main before W01 (aiToolsBrowser.ts, '
        + 'peripheralPolicyState.ts) were converted; PRE_EXISTING_NON_AI_INSERTS is frozen.',
    ).toEqual([]);
  });

  it('no AI tool or agent file statically imports an un-attributed dispatch function', () => {
    const offenders = FILES.filter((f) => AI_FILE.test(f) && !AI_RAW_DISPATCH_ALLOWED.has(f)).filter(
      (f) => {
        const text = read(f);
        const imports =
          text.match(
            /^import\s[\s\S]*?from\s+'[^']*(?:commandQueue|dispatchDeviceCommand|scriptDispatch)';$/gm,
          ) ?? [];
        return imports.some((line) => RAW_DISPATCH.test(line));
      },
    );

    expect(
      offenders,
      'AI code must import from services/aiDispatch.ts, whose signatures require aiOrigin.',
    ).toEqual([]);
  });

  it('no AI tool or agent file reaches the queue by a LAZY import outside the reviewed allowlist', () => {
    // A dynamic `await import('./commandQueue')` is invisible to the static
    // scan above, which is how a new tool could quietly re-open the hole.
    const lazy = /\bimport\s*\(\s*'[^']*(?:commandQueue|dispatchDeviceCommand|scriptDispatch)'\s*\)/;
    const offenders = FILES.filter(
      (f) =>
        AI_FILE.test(f)
        && !AI_RAW_DISPATCH_ALLOWED.has(f)
        && !AI_LAZY_DISPATCH_ALLOWED.has(f)
        && lazy.test(read(f)),
    );

    expect(
      offenders,
      'A lazy `await import("./commandQueue")` bypasses the static import scan. '
        + 'Either route the dispatch through services/aiDispatch.ts, or add the file to '
        + 'AI_LAZY_DISPATCH_ALLOWED with a note saying where it supplies aiOrigin.',
    ).toEqual([]);
  });

  it('every allowlist entry still names a file that exists', () => {
    const missing = [
      ...AI_LAZY_DISPATCH_ALLOWED.keys(),
      ...AI_RAW_DISPATCH_ALLOWED,
      ...PRE_EXISTING_NON_AI_INSERTS,
      ...INSERT_CHOKEPOINTS,
    ].filter((f) => !FILES.includes(f));

    expect(missing, 'a renamed or deleted file leaves a stale waiver behind').toEqual([]);
  });

  it('every frozen-baseline insert site still actually contains a raw insert', () => {
    // A baseline entry whose insert has since been removed is dead weight that
    // would silently re-admit a future raw insert in the same file.
    const re = /\b(?:db|tx|trx|client)\s*\.\s*insert\s*\(\s*(?:deviceCommands|scriptExecutions)\b/;
    const stale = [...PRE_EXISTING_NON_AI_INSERTS].filter((f) => !re.test(read(f)));

    expect(stale, 'drop the entry: this file no longer inserts directly').toEqual([]);
  });

  // #5789 — `aiInsertQueuedCommandInTransaction` (services/aiDispatch.ts) is a
  // required-origin wrapper around `insertQueuedCommandInTransaction`: it
  // stamps the origin columns but writes NO `ai.command.executed` audit row
  // (unlike `queueCommand`), by design. That design is only safe today because
  // every caller that threads `aiOrigin` through the underlying transaction-
  // scoped insert passes `undefined` (peripheralPolicyState.ts's BullMQ
  // reconciliation lane is an INDIRECT AI lane, spec OD-3 B, that W01
  // deliberately left unattributed). The day a caller supplies a REAL
  // aiOrigin here, that becomes a live one-`ai.`-row-per-mutation violation.
  // #5789 is the seam owner for designing that audit write before the guard
  // below is allowed to go away.
  it('every caller of insertQueuedCommandInTransaction that mentions aiOrigin passes it only through the guarded, always-undefined-today shape', () => {
    const definerFiles = new Set([...INSERT_CHOKEPOINTS, 'apps/api/src/services/aiDispatch.ts']);
    const callSite = /\binsertQueuedCommandInTransaction\s*\(/;
    const guarded = /\.\.\.\(aiOrigin\s*\?\s*\{\s*aiOrigin\s*\}\s*:\s*\{\}\)/;
    const callersWithOrigin = FILES.filter(
      (f) => !definerFiles.has(f) && callSite.test(read(f)) && /\baiOrigin\b/.test(read(f)),
    );

    // Sanity: exactly one caller threads aiOrigin through this insert today.
    // An empty list would make the guard assertion below vacuous; a grown
    // list means a new caller needs the same review this one got.
    expect(callersWithOrigin).toEqual(['apps/api/src/services/peripheralPolicyState.ts']);

    const unguarded = callersWithOrigin.filter((f) => !guarded.test(read(f)));
    expect(
      unguarded,
      'A caller now supplies aiOrigin to insertQueuedCommandInTransaction unconditionally, but '
        + 'aiInsertQueuedCommandInTransaction (services/aiDispatch.ts) writes no ai.command.executed audit row '
        + 'by design. Design that audit write (#5789) before removing this guard.',
    ).toEqual([]);
  });
});
