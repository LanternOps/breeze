/**
 * CONTRACT TEST — command delivery to devices parked in a holding org.
 *
 * A device in its partner's holding org (`organizations.type =
 * 'unassigned_pool'`) receives lifecycle removal and nothing else. That rule
 * is enforced at several layers (enqueue chokepoints, raw inserts, both claim
 * paths, the socket primitive), and this test is the forcing function that
 * keeps a NEW call site from skipping them: it scans the source for every way
 * a command reaches a device and requires each file to be classified.
 *
 * Scanned call-site patterns (comments stripped first):
 *   - `insert(deviceCommands)` and raw `INSERT INTO device_commands`
 *   - `insertQueuedCommandInTransaction(`
 *   - `sendCommandToAgent(`, `sendCommandToAgentAwaitResult(`,
 *     `dispatchCommandToAgent(`
 *
 * Kinds, and what each one must prove about its file:
 *   - eligibility  — calls the delivery-eligibility helper
 *                    (`assertCommandDeliverable`, `isParkedDevice`, or
 *                    `isParkedDeliverableCommandType` next to its own org read).
 *   - lifecycle    — sends/inserts only removal or session-teardown types; every
 *                    `type: '…'` literal and `type: CommandTypes.X` constant in
 *                    the file must be in the entry's list, and the list inside
 *                    LIFECYCLE_TYPES.
 *   - chokepoint   — writes only through `insertQueuedCommandInTransaction`
 *                    (which refuses parked devices) and pushes only rows it
 *                    claimed with `claimPendingCommandForDelivery` (which
 *                    cancels them); no raw insert in the file.
 *   - remote_gated — remote-session surfaces behind the remote-access gate;
 *                    rowless pushes over the agent socket.
 *   - socket_only  — rowless pushes over the agent socket and nothing else. A
 *                    parked device never holds that socket (see the guard
 *                    assertions below), and the primitive refuses anyway.
 *   - primitive    — the definitions (and the relay leg) themselves.
 *
 * An unclassified hit fails; a stale entry (no hit left) fails.
 *
 * Plain unit test — reads the source tree only. The behavioural proof lives
 * in integration/parkedCommandDelivery.integration.test.ts and the co-located
 * unit suites of each file.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, relative, resolve } from 'path';
import { CommandTypes } from '../services/commandTypes';

const SRC = resolve(__dirname, '..');
const EE = resolve(__dirname, '../../../../ee');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Drop block comments and whole-line `//` comments; keep code and strings. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const SOURCE = [
  ...walk(SRC).map((f) => ({ file: relative(SRC, f).replace(/\\/g, '/'), full: f })),
  ...(existsSync(EE) ? walk(EE).map((f) => ({ file: `ee/${relative(EE, f).replace(/\\/g, '/')}`, full: f })) : []),
].map(({ file, full }) => {
  const raw = readFileSync(full, 'utf8');
  return { file, raw, code: stripComments(raw) };
});

const RAW_INSERT_PATTERNS = [
  /\binsert\(\s*(?:schema\.)?deviceCommands\s*\)/,
  /INSERT\s+INTO\s+(?:public\.)?"?device_commands"?/i,
];
const CALL_PATTERNS = [
  ...RAW_INSERT_PATTERNS,
  /\binsertQueuedCommandInTransaction\(/,
  /\bsendCommandToAgent\(/,
  /\bsendCommandToAgentAwaitResult\(/,
  /\bdispatchCommandToAgent\(/,
];
const SEND_PATTERNS = [/\bsendCommandToAgent\(/, /\bsendCommandToAgentAwaitResult\(/, /\bdispatchCommandToAgent\(/];

const ELIGIBILITY_MARKERS = ['assertCommandDeliverable(', 'isParkedDevice(', 'isParkedDeliverableCommandType('];

/** Removal, or teardown of a session a parked device can never have. */
const LIFECYCLE_TYPES = [
  'self_uninstall',
  'desktop_stream_stop',
  'tunnel_close',
  'terminal_stop',
  'support_end',
] as const;

type Classification =
  | { kind: 'eligibility'; reason: string }
  | { kind: 'lifecycle'; reason: string; types: readonly (typeof LIFECYCLE_TYPES)[number][] }
  | { kind: 'chokepoint'; reason: string }
  | { kind: 'remote_gated'; reason: string }
  | { kind: 'socket_only'; reason: string }
  | { kind: 'primitive'; reason: string; defines: RegExp };

const SOCKET_ONLY_REASON =
  'Rowless push over the live agent socket; a parked device is never admitted to that socket';
const REMOTE_REASON =
  'Remote-session surface behind the remote-access gate; rowless pushes over the agent socket only';

/** file (relative to apps/api/src, or `ee/...`) -> classification. */
const CLASSIFICATION: Record<string, Classification> = {
  // --- eligibility: the file calls the delivery-eligibility helper ---------
  'services/commandQueue.ts': {
    kind: 'eligibility',
    reason: 'queueCommand asserts before its insert; the executeCommand precheck refuses before its insert',
  },
  'services/commandQueueInsert.ts': {
    kind: 'eligibility',
    reason: 'The transactional insert chokepoint asserts on the caller transaction before the insert',
  },
  'services/dispatchDeviceCommand.ts': {
    kind: 'eligibility',
    reason: 'The enqueue seam answers device_pending_assignment before trust and persistence',
  },
  'services/scriptDispatch.ts': {
    kind: 'eligibility',
    reason: 'Script dispatch refuses before any execution row is written or secret sealed',
  },
  'services/peripheralPolicyState.ts': {
    kind: 'eligibility',
    reason: 'Peripheral reconciliation treats a parked device as incompatible and writes nothing',
  },
  'services/wakeOnLan.ts': {
    kind: 'eligibility',
    reason: 'Wake-on-LAN refuses a parked target and a parked relay before the relay row is written',
  },
  'jobs/pamActuationWorker.ts': {
    kind: 'eligibility',
    reason: 'The dispatch read joins the device org type; a parked device fails the actuation before the raw insert',
  },
  'routes/devices/actuateElevation.ts': {
    kind: 'eligibility',
    reason: 'Asserted first in the actuation transaction, before the approval flip and the insert',
  },
  'routes/mobile.ts': {
    kind: 'eligibility',
    reason: 'Mobile device actions assert before the raw insert (409 DEVICE_PENDING_ASSIGNMENT)',
  },
  'routes/agents/helpers.ts': {
    kind: 'eligibility',
    reason: 'Threshold filesystem scans and the continuation fallback skip a parked device before inserting',
  },
  'jobs/backupWorker.ts': {
    kind: 'eligibility',
    reason: 'Dispatch refuses a parked device at precheck and before every send; the post-send backup_stop persists only through the gated insert',
  },
  'routes/devPush.ts': {
    kind: 'eligibility',
    reason: 'Dev push refuses a parked target before staging; the agent-token download re-checks the org',
  },

  // --- lifecycle: removal or teardown types only ---------------------------
  'services/deviceUninstallDrain.ts': {
    kind: 'lifecycle',
    reason: 'Device removal drain queues self_uninstall, the one type a parked device receives',
    types: ['self_uninstall'],
  },
  'services/tenantOffboarding.ts': {
    kind: 'lifecycle',
    reason: 'Tenant offboarding drain queues self_uninstall, the one type a parked device receives',
    types: ['self_uninstall'],
  },
  'routes/admin/abuse.ts': {
    kind: 'lifecycle',
    reason: 'Abuse suspension queues self_uninstall, the one type a parked device receives',
    types: ['self_uninstall'],
  },
  'services/desktopSessionStop.ts': {
    kind: 'lifecycle',
    reason: 'Desktop stream stop tears down a session a parked device cannot have; the parked claim cancels any such row (not on the removal allowlist)',
    types: ['desktop_stream_stop'],
  },
  'services/remoteSessionTeardown.ts': {
    kind: 'lifecycle',
    reason: 'Remote-session teardown stops tunnels/terminals/desktops; carries no operator content',
    types: ['tunnel_close', 'terminal_stop'],
  },
  'services/quickSupportEnd.ts': {
    kind: 'lifecycle',
    reason: 'Quick Support end tears down a support session; carries no operator content',
    types: ['support_end'],
  },

  // --- chokepoint: writes via the gated insert, pushes only claimed rows ---
  'services/aiDispatch.ts': {
    kind: 'chokepoint',
    reason: 'AI-origin commands persist only through insertQueuedCommandInTransaction',
  },
  'services/agentRollback.ts': {
    kind: 'chokepoint',
    reason: 'Rollback directives persist only through insertQueuedCommandInTransaction',
  },
  'services/scriptCancellation.ts': {
    kind: 'chokepoint',
    reason: 'Cancel rows persist through the gated insert and are pushed only after the single-row claim',
  },
  'services/topology/diagnosticDispatch.ts': {
    kind: 'chokepoint',
    reason: 'Diagnostic and cancel rows persist only through insertQueuedCommandInTransaction',
  },
  'services/topology/telemetryArms.ts': {
    kind: 'chokepoint',
    reason: 'Interface-poll rows persist only through insertQueuedCommandInTransaction',
  },
  'services/topology/diagnosticDelivery.ts': {
    kind: 'chokepoint',
    reason: 'Pushes a diagnostic row only after claimPendingCommandForDelivery claimed it',
  },

  // --- remote_gated ---------------------------------------------------------
  'routes/terminalWs.ts': { kind: 'remote_gated', reason: REMOTE_REASON },
  'routes/desktopWs.ts': { kind: 'remote_gated', reason: REMOTE_REASON },
  'routes/tunnelWs.ts': { kind: 'remote_gated', reason: REMOTE_REASON },
  'routes/tunnels.ts': { kind: 'remote_gated', reason: REMOTE_REASON },
  'routes/tunnelHttp.ts': { kind: 'remote_gated', reason: REMOTE_REASON },
  'routes/remote/sessions.ts': { kind: 'remote_gated', reason: REMOTE_REASON },

  // --- socket_only: rowless probes over the live socket ---------------------
  'jobs/discoveryWorker.ts': { kind: 'socket_only', reason: SOCKET_ONLY_REASON },
  'jobs/monitorWorker.ts': { kind: 'socket_only', reason: SOCKET_ONLY_REASON },
  'jobs/snmpWorker.ts': { kind: 'socket_only', reason: SOCKET_ONLY_REASON },
  'routes/discoveryAssetProbe.ts': { kind: 'socket_only', reason: SOCKET_ONLY_REASON },
  'routes/monitors.ts': { kind: 'socket_only', reason: SOCKET_ONLY_REASON },
  'routes/devices/sessions.ts': { kind: 'socket_only', reason: SOCKET_ONLY_REASON },

  // --- primitive -------------------------------------------------------------
  'routes/agentWs.ts': {
    kind: 'primitive',
    reason: 'Defines the socket send primitive, which refuses a parked connection itself',
    defines: /export function sendCommandToAgent\(/,
  },
  'services/agentCommandAwait.ts': {
    kind: 'primitive',
    reason: 'Defines the await-result wrapper, which sends through sendCommandToAgent',
    defines: /export function sendCommandToAgentAwaitResult\(/,
  },
  'services/agentCommandRelay.ts': {
    kind: 'primitive',
    reason: 'Defines the cross-process facade; both legs end in sendCommandToAgent',
    defines: /export async function dispatchCommandToAgent\(/,
  },
  'jobs/agentCommandRelayWorker.ts': {
    kind: 'primitive',
    reason: 'The relay leg: opens the sealed envelope and hands it to sendCommandToAgent on the socket owner',
    defines: /openRelayCommand\(/,
  },
};

const hits = SOURCE.filter((s) => CALL_PATTERNS.some((p) => p.test(s.code)));
const byFile = new Map(SOURCE.map((s) => [s.file, s]));

describe('command delivery call sites are classified for parked devices', () => {
  it('every call site is classified', () => {
    const unclassified = hits.map((h) => h.file).filter((f) => !(f in CLASSIFICATION)).sort();
    expect(unclassified).toEqual([]);
  });

  it('no classification entry is stale', () => {
    const hitFiles = new Set(hits.map((h) => h.file));
    const stale = Object.keys(CLASSIFICATION).filter((f) => !hitFiles.has(f)).sort();
    expect(stale).toEqual([]);
  });

  it.each(Object.entries(CLASSIFICATION))('%s satisfies its classification', (file, entry) => {
    const source = byFile.get(file);
    expect(source, `${file} no longer exists`).toBeDefined();
    const { code } = source!;
    const hasRawInsert = RAW_INSERT_PATTERNS.some((p) => p.test(code));
    const hasSend = SEND_PATTERNS.some((p) => p.test(code));
    expect(entry.reason.length, `${file}: give a reason a reviewer can check`).toBeGreaterThan(20);

    switch (entry.kind) {
      case 'eligibility':
        expect(
          ELIGIBILITY_MARKERS.some((m) => code.includes(m)),
          `${file} is classified eligibility but calls none of ${ELIGIBILITY_MARKERS.join(', ')}`,
        ).toBe(true);
        break;
      case 'lifecycle': {
        for (const t of entry.types) expect(LIFECYCLE_TYPES).toContain(t);
        const quoted = [...code.matchAll(/\btype:\s*['"]([A-Za-z0-9_.-]+)['"]/g)].map((m) => m[1]);
        // `type: CommandTypes.X` resolves through the real registry, so an
        // operator command named by constant is caught like a literal.
        const byConstant = [...code.matchAll(/\btype:\s*CommandTypes\.([A-Z0-9_]+)/g)].map((m) => {
          const value = (CommandTypes as Record<string, string>)[m[1]!];
          expect(value, `${file}: CommandTypes.${m[1]} does not exist`).toBeDefined();
          return value;
        });
        const literals = [...quoted, ...byConstant];
        expect(literals.length, `${file}: no command type literal found`).toBeGreaterThan(0);
        for (const literal of literals) {
          expect(entry.types, `${file} names command type '${literal}'`).toContain(literal);
        }
        break;
      }
      case 'chokepoint':
        expect(hasRawInsert, `${file} writes device_commands directly`).toBe(false);
        if (hasSend) {
          expect(
            code.includes('claimPendingCommandForDelivery('),
            `${file} pushes a command it did not claim through claimPendingCommandForDelivery`,
          ).toBe(true);
        }
        break;
      case 'remote_gated':
        expect(hasRawInsert, `${file} writes device_commands directly`).toBe(false);
        expect(
          code.includes('checkRemoteAccess') || code.includes('remoteWsAuthorization'),
          `${file} is classified remote_gated but has no remote-access gate`,
        ).toBe(true);
        break;
      case 'socket_only':
        expect(hasRawInsert, `${file} writes device_commands directly`).toBe(false);
        expect(code.includes('insertQueuedCommandInTransaction('), `${file} persists commands`).toBe(false);
        break;
      case 'primitive':
        expect(entry.defines.test(code), `${file} no longer matches ${entry.defines}`).toBe(true);
        break;
    }
  });
});

/**
 * The text of the function (or route handler) that starts at `anchor`, up to
 * its closing brace. For an anchor ending in `(` the parameter list is skipped
 * by paren matching first (parameters may carry multi-line type literals);
 * the body is then the first `{` that ends a line, which also skips inline
 * type literals in a return type (`Promise<{ id: string } | null>`).
 */
function bodyAfter(file: string, anchor: string): string {
  const source = byFile.get(file);
  if (!source) throw new Error(`${file} not found`);
  const code = source.code;
  const start = code.indexOf(anchor);
  if (start < 0) throw new Error(`${anchor} not found in ${file}`);
  let from = start + anchor.length;
  if (anchor.endsWith('(')) {
    let parens = 1;
    while (from < code.length && parens > 0) {
      if (code[from] === '(') parens++;
      else if (code[from] === ')') parens--;
      from++;
    }
  }
  const open = code.indexOf('{\n', from);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${anchor} in ${file}`);
}

/**
 * The layers the `socket_only`, `remote_gated` and `chokepoint` kinds rely on.
 * Each guard is pinned to the function that must carry it, so removing one
 * fails here rather than silently widening every classified caller.
 */
const GUARDS: Array<{ name: string; file: string; anchor: string; markers: string[] }> = [
  {
    name: 'the agent socket upgrade refuses a parked device',
    file: 'routes/agentWs.ts',
    anchor: 'export async function validateAgentToken(',
    markers: ['isUnassignedPoolOrgType(device.organizationType)'],
  },
  {
    name: 'the periodic socket re-check refuses a parked device',
    file: 'routes/agentWs.ts',
    anchor: 'export async function isAgentDeviceStillAuthorized(',
    markers: ['isUnassignedPoolOrgType(row.orgType)'],
  },
  {
    name: 'the socket send primitive refuses non-removal commands for a parked connection',
    file: 'routes/agentWs.ts',
    anchor: 'export function sendCommandToAgent(',
    markers: ['conn.parked', 'isParkedDeliverableCommandType('],
  },
  {
    name: 'the single-row push claim hands the device org type to the shared claim-time eligibility (which cancels non-removal rows for a parked device)',
    file: 'services/commandDispatch.ts',
    anchor: 'async function claimInSavepoint(',
    markers: ['orgType: organizations.type', 'orgType: candidate.orgType', 'partitionClaimable('],
  },
  {
    name: 'the batch claim reads the device org type',
    file: 'services/commandDispatch.ts',
    anchor: 'export async function claimPendingCommandsForDevice(',
    markers: ['orgType: organizations.type'],
  },
  {
    name: 'the narrowed (parked) claim cancels refused rows instead of leaving them pending',
    file: 'services/commandDispatch.ts',
    anchor: 'export async function claimPendingCommandsForDevice(',
    markers: [
      'isUnassignedPoolOrgType(parkedDevice.orgType)',
      'notInArray(deviceCommands.type, [...typeAllowlist])',
      'partitionClaimable(tx, parkedDevice, refused)',
    ],
  },
  {
    name: 'claim-time eligibility cancels non-removal rows for a parked device',
    file: 'services/commandClaimEligibility.ts',
    anchor: 'export async function partitionClaimable(',
    markers: ['isUnassignedPoolOrgType(device.orgType)'],
  },
  {
    name: 'the transactional insert chokepoint refuses a parked device',
    file: 'services/commandQueueInsert.ts',
    anchor: 'export async function insertQueuedCommandInTransaction(',
    markers: ['assertCommandDeliverable('],
  },
  {
    name: 'the dev push binary download (agent-token authenticated) refuses a parked device',
    file: 'routes/devPush.ts',
    anchor: "devPushRoutes.get('/push/download/:token', async (c) =>",
    markers: ['innerJoin(organizations', 'isUnassignedPoolOrgType(agentDevice.orgType)'],
  },
];

describe('parked-device delivery guards stay in place', () => {
  it.each(GUARDS)('$name', ({ file, anchor, markers }) => {
    const body = bodyAfter(file, anchor);
    for (const marker of markers) {
      expect(body, `${file} ${anchor} lost ${marker}`).toContain(marker);
    }
  });
});
