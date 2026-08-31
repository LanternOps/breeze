import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  agentAcceptsServedEdition,
  agentBinaryUpdateDispatchRefusal,
  AGENT_BINARY_UPDATE_COMMAND_TYPES,
} from './agentEditionCompat';

const ORIGINAL_EDITION = process.env.BINARY_EDITION;

afterEach(() => {
  if (ORIGINAL_EDITION === undefined) delete process.env.BINARY_EDITION;
  else process.env.BINARY_EDITION = ORIGINAL_EDITION;
});

// #4093 — the dispatch-side counterpart of the heartbeat's offer gate. The
// predicate itself (agentAcceptsServedEdition) is covered in
// routes/agents/helpers.agentUpdatePolicy.test.ts; these cover the wrapper
// that decides whether a COMMAND may be dispatched.
describe('agentBinaryUpdateDispatchRefusal (#4093)', () => {
  const strandedDevice = {
    agentEdition: null,
    agentVersion: '0.105.1',
    watchdogVersion: '0.105.1',
  };

  beforeEach(() => {
    process.env.BINARY_EDITION = 'hosted';
  });

  it('is inert for every command type that does not download a binary', () => {
    for (const type of ['restart_agent', 'run_script', 'reboot', 'dev_update']) {
      expect(
        agentBinaryUpdateDispatchRefusal({
          commandType: type,
          targetRole: 'watchdog',
          device: strandedDevice,
        }),
      ).toBeNull();
    }
  });

  it('covers exactly the two agent-binary update command types', () => {
    expect([...AGENT_BINARY_UPDATE_COMMAND_TYPES].sort()).toEqual([
      'update_agent',
      'update_watchdog',
    ]);
  });

  it('refuses a stranded self-host build on a hosted control plane', () => {
    const reason = agentBinaryUpdateDispatchRefusal({
      commandType: 'update_agent',
      targetRole: 'watchdog',
      device: strandedDevice,
    });
    expect(reason).toMatch(/withheld/i);
    // The reason must name the observed facts the operator needs, not just
    // "refused" — this string is what lands in the AI tool's per-device error.
    expect(reason).toContain('version=0.105.1');
    expect(reason).toContain('edition=none');
  });

  it('allows a build that reports its edition', () => {
    expect(
      agentBinaryUpdateDispatchRefusal({
        commandType: 'update_agent',
        targetRole: 'watchdog',
        device: { agentEdition: 'self-host', agentVersion: '0.108.0', watchdogVersion: '0.108.0' },
      }),
    ).toBeNull();
  });

  it('reads the version band off the WATCHDOG, the binary that downloads', () => {
    // Main agent inside the check band, watchdog below it → allowed.
    expect(
      agentBinaryUpdateDispatchRefusal({
        commandType: 'update_agent',
        targetRole: 'watchdog',
        device: { agentEdition: null, agentVersion: '0.106.0', watchdogVersion: '0.104.0' },
      }),
    ).toBeNull();
    // The reverse → refused.
    expect(
      agentBinaryUpdateDispatchRefusal({
        commandType: 'update_agent',
        targetRole: 'watchdog',
        device: { agentEdition: null, agentVersion: '0.104.0', watchdogVersion: '0.106.0' },
      }),
    ).toMatch(/withheld/i);
  });

  it('falls back to the agent version only when no watchdog version was ever reported', () => {
    expect(
      agentBinaryUpdateDispatchRefusal({
        commandType: 'update_agent',
        targetRole: 'watchdog',
        device: { agentEdition: null, agentVersion: '0.104.0', watchdogVersion: null },
      }),
    ).toBeNull();
    expect(
      agentBinaryUpdateDispatchRefusal({
        commandType: 'update_agent',
        targetRole: 'watchdog',
        device: { agentEdition: null, agentVersion: '0.105.1', watchdogVersion: null },
      }),
    ).toMatch(/withheld/i);
  });

  it('refuses a dispatch that does not target the watchdog', () => {
    expect(
      agentBinaryUpdateDispatchRefusal({
        commandType: 'update_agent',
        targetRole: 'agent',
        device: { agentEdition: 'hosted', agentVersion: '0.108.0', watchdogVersion: '0.108.0' },
      }),
    ).toMatch(/targetRole 'watchdog'/);
  });

  it('refuses a self-host artifact aimed at a hosted-edition build', () => {
    process.env.BINARY_EDITION = 'self-host';
    expect(
      agentBinaryUpdateDispatchRefusal({
        commandType: 'update_watchdog',
        targetRole: 'watchdog',
        device: { agentEdition: 'hosted', agentVersion: '0.108.0', watchdogVersion: '0.108.0' },
      }),
    ).toMatch(/withheld/i);
    // …and still allows the same server's own edition.
    expect(
      agentBinaryUpdateDispatchRefusal({
        commandType: 'update_watchdog',
        targetRole: 'watchdog',
        device: { agentEdition: 'self-host', agentVersion: '0.108.0', watchdogVersion: '0.108.0' },
      }),
    ).toBeNull();
  });

  it('agrees with the raw predicate on the fail-closed unparseable case', () => {
    expect(agentAcceptsServedEdition({ reportedEdition: null, agentVersion: 'dev-abc' })).toBe(false);
    expect(
      agentBinaryUpdateDispatchRefusal({
        commandType: 'update_agent',
        targetRole: 'watchdog',
        device: { agentEdition: null, agentVersion: 'dev-abc', watchdogVersion: 'dev-abc' },
      }),
    ).toMatch(/withheld/i);
  });
});

// ============================================================
// Dispatch-site registry (#4093)
// ============================================================
//
// The gate above only helps if every dispatcher goes through it. Two runtime
// guards already exist — `executeCommand` evaluates the gate and `queueCommand`
// refuses these types outright — but a hand-rolled `db.insert(deviceCommands)`
// would evade both. Any such file has to NAME the command type, so this scan
// pins the set of files allowed to mention one.
//
// This is deliberately a static contract, not a code-review convention: the
// same class of "new call site forgot the registration" bug has shipped
// repeatedly in this repo and review has never been what caught it.
describe('agent-binary update command types are only named at known sites (#4093)', () => {
  // apps/api — the server (src/) and the operator scripts, which insert
  // device_commands rows of their own (scripts/recover-stuck-agents.ts) — plus
  // ee/, whose built-in extensions compile into the same API image and could
  // grow a dispatch path of their own.
  //
  // LIMITATION, so a future reader does not over-trust this: it matches the
  // literal command-type strings. A dispatcher that reached them indirectly
  // (e.g. spreading AGENT_BINARY_UPDATE_COMMAND_TYPES) would slip past. The
  // runtime guards are the real enforcement — executeCommand evaluates the
  // gate and queueCommand refuses these types; this scan exists to catch the
  // remaining hole, a hand-rolled db.insert(deviceCommands).
  const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
  const API_ROOT = join(__dirname, '..', '..');
  const SCAN_ROOTS = [
    join(API_ROOT, 'src'),
    join(API_ROOT, 'scripts'),
    join(REPO_ROOT, 'ee'),
  ].filter((dir) => existsSync(dir));

  // Every file that may mention 'update_agent' / 'update_watchdog'.
  // Adding a file here means: you are dispatching an agent-binary update, so
  // route it through executeCommand(..., { targetRole: 'watchdog' }) — that is
  // the only path that applies agentBinaryUpdateDispatchRefusal.
  const ALLOWED = new Set([
    'apps/api/src/services/agentEditionCompat.ts', // the gate itself
    'apps/api/src/services/aiToolsAgentMgmt.ts', // trigger_agent_upgrade — the one dispatcher
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (entry.endsWith('.ts') && !entry.includes('.test.')) out.push(full);
    }
    return out;
  }

  // Generous timeout: this reads every .ts file under apps/api, which is a
  // couple of thousand synchronous reads and can exceed the 5s default when
  // the suite runs alongside others.
  it('only the gate and the known dispatcher name update_agent / update_watchdog', () => {
    const files = SCAN_ROOTS.flatMap((root) => walk(root));
    const offenders = files
      .filter((file) => /\bupdate_(agent|watchdog)\b/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(REPO_ROOT.length + 1))
      .filter((rel) => !ALLOWED.has(rel))
      .sort();

    // Guard the guard: an empty scan would make this vacuously green.
    expect(files.length).toBeGreaterThan(100);

    expect(
      offenders,
      'A new file names an agent-binary update command type. Dispatch it through ' +
        "executeCommand(deviceId, type, payload, { targetRole: 'watchdog' }) so the " +
        'artifact-edition gate (#4093/#4072) applies, then add the file to ALLOWED here. ' +
        'A raw db.insert(deviceCommands) bypasses the gate and can strand devices.',
    ).toEqual([]);
  }, 60_000);
});
