/**
 * Alerts for a machine that has stopped updating (#11074, spec 4.2 and 4.5). One
 * worker stage: first settles what is open, then raises what is new.
 *
 * Every state comes from `classifyOemDevice`, the rule behind the device section and
 * the fleet view, so an alert never says something those screens do not.
 *
 * | Rule | Raised when | Once per | Resolved when |
 * |---|---|---|---|
 * | device overdue | the state reads `overdue` | occurrence | a run finished after the alert, or the device left management |
 * | restart overdue | the state reads `reboot_overdue` | owed restart | the state no longer does |
 * | schedule not handed back | the release sweep gave up | takeover | `reason` no longer says so |
 * | run failing | the state reads `failing`, the last night has passed, and the last run was this occurrence's scheduled one | occurrence | a run finished after the alert, the next occurrence started, or the device left management |
 *
 * Run failing never fires while a retry is possible, and it leaves `overdue` to its own
 * rule: attempts used up reads `overdue`, so that device raises only the overdue rule. A
 * Run Now is told apart by the `trigger` on the command the status row points at
 * (`lastCommandId`, written for every run): a tech who ran it has the answer.
 *
 * Neither rule fires for a device reading `failing` with no scheduled run this occurrence:
 * its last failure was an earlier month's, or a Run Now's. It stays visible in the tab only.
 *
 * "Once" outlives the alert: a tech who closes one is not paged again that month. There
 * is no marker column, because the alert row itself is the record, its `dedupeKey` read
 * back here. An alert still open from an earlier occurrence stands in for a new one.
 *
 * Maintenance windows suppress, and the device stays eligible, so it is raised on a
 * later tick once the window has passed. Each attempt counts against a per-tick cap, per
 * rule, so a fleet going overdue together, or an org-wide window over thousands of
 * devices, is paced rather than a burst of notifications. A step that hits its cap
 * resumes behind the last device it tried, then wraps round: devices that cannot alert
 * right now take a turn each, not every tick's first slots, so they cannot starve the
 * other orgs' devices behind them.
 *
 * Reads run in short system contexts, one per page (#1105).
 */
import { and, eq, gt, inArray, isNotNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  deviceCommands,
  deviceHardware,
  deviceOemUpdateStatus,
  devices,
  organizations,
  partners,
  sites,
} from '../../db/schema';
import { captureException } from '../sentry';
import { notParkedDeviceCondition } from '../unassignedPool/selectorPredicate';
import {
  emitOverdueAlert,
  emitRebootOverdueAlert,
  emitRunFailingAlert,
  emitScheduleNotHandedBackAlert,
  listOpenOemAlerts,
  OEM_NOT_RETURNED_RULE_NAME,
  OEM_OVERDUE_RULE_NAME,
  OEM_REBOOT_OVERDUE_RULE_NAME,
  OEM_RUN_FAILING_RULE_NAME,
  OEM_SCHEDULE_NOT_HANDED_BACK_RULE_NAME,
  oemRuleSwitchedOff,
  priorOemAlerts,
  resolveOemAlert,
  type OpenOemAlert,
} from './alerts';
import { armedScope, effectiveTimezoneFrom, maxDispatchPerTick, type DeviceTimezoneFields } from './candidates';
import { FAILING_OUTCOMES, hadAChanceAtLastNight, OEM_REBOOT_OVERDUE_NIGHTS } from './displayState';
import { oemUpdatesFlagOn } from './flags';
import {
  classifyOemDevice,
  oemOccurrenceMemo,
  oemOfferedLane,
  type OemClassification,
  type OemDeviceFacts,
} from './policySide';
import { OEM_RELEASE_GAVE_UP } from './releaseSweep';
import { resolveOemUpdatesLinksForDevices, type ResolvedOemUpdatesLink } from './resolver';

const PAGE_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

type SweepRow = OemDeviceFacts & DeviceTimezoneFields & {
  orgId: string;
  reason: string | null;
  lastAttemptAt: Date | null;
  returnDeadlineAt: Date | null;
  lastCommandId: string | null;
  /** The trigger of the run the status row is on: `scheduled` or `on_demand`. */
  lastTrigger: string | null;
};

function report(error: unknown, orgId: string | null, what: string): void {
  console.error(`[OemUpdates] overdue sweep: ${what} failed:`, error);
  captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
    worker: 'oemUpdatesWorker',
    ...(orgId ? { org_id: orgId } : {}),
  });
}

function loadRows(where: SQL | undefined, after: string | null): Promise<SweepRow[]> {
  return withSystemDbAccessContext(() => db
    .select({
      deviceId: devices.id,
      orgId: devices.orgId,
      partnerId: organizations.partnerId,
      osType: devices.osType,
      isVirtual: devices.isVirtual,
      deviceRole: devices.deviceRole,
      enrolledAt: devices.enrolledAt,
      manufacturer: deviceHardware.manufacturer,
      model: deviceHardware.model,
      siteTimezone: sites.timezone,
      orgSettings: organizations.settings,
      partnerTimezone: partners.timezone,
      partnerSettings: partners.settings,
      statusLane: deviceOemUpdateStatus.lane,
      applicability: deviceOemUpdateStatus.applicability,
      reason: deviceOemUpdateStatus.reason,
      lastOutcome: deviceOemUpdateStatus.lastOutcome,
      occurrenceKey: deviceOemUpdateStatus.occurrenceKey,
      attempts: deviceOemUpdateStatus.attempts,
      lastAttemptAt: deviceOemUpdateStatus.lastAttemptAt,
      lastSuccessAt: deviceOemUpdateStatus.lastSuccessAt,
      rebootPendingSince: deviceOemUpdateStatus.rebootPendingSince,
      returnDeadlineAt: deviceOemUpdateStatus.returnDeadlineAt,
      lastCommandId: deviceOemUpdateStatus.lastCommandId,
      lastTrigger: sql<string | null>`${deviceCommands.payload} ->> 'trigger'`,
    })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .leftJoin(sites, eq(sites.id, devices.siteId))
    .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
    .leftJoin(deviceOemUpdateStatus, eq(deviceOemUpdateStatus.deviceId, devices.id))
    .leftJoin(deviceCommands, eq(deviceCommands.id, deviceOemUpdateStatus.lastCommandId))
    .where(and(
      eq(devices.isEphemeral, false),
      ne(devices.status, 'decommissioned'),
      notParkedDeviceCondition(),
      where,
      after ? gt(devices.id, after) : undefined,
    ))
    .orderBy(devices.id)
    .limit(PAGE_SIZE)) as Promise<SweepRow[]>;
}

/** One sweep's shared state. Most devices share a schedule and a zone. */
function sweepContext(now: Date) {
  return {
    now,
    occurrenceOf: oemOccurrenceMemo(now),
    /** What is left of the current step's cap. */
    remaining: maxDispatchPerTick(),
    lastAttempted: null as string | null,
    switchedOff: new Map<string, boolean>(),
  };
}
type SweepContext = ReturnType<typeof sweepContext>;

async function classifyPage(rows: SweepRow[], context: SweepContext): Promise<Map<string, OemClassification>> {
  const offered = new Map(rows.map((row) => [row.deviceId, oemOfferedLane(row)]));
  const needingLink = rows.filter((row) => offered.get(row.deviceId)).map((row) => row.deviceId);
  const links: Map<string, ResolvedOemUpdatesLink> = needingLink.length > 0
    ? await withSystemDbAccessContext(() => resolveOemUpdatesLinksForDevices(needingLink))
    : new Map();
  return new Map(rows.map((row) => [row.deviceId, classifyOemDevice({
    facts: row,
    lane: offered.get(row.deviceId) ?? null,
    link: links.get(row.deviceId) ?? null,
    timezone: effectiveTimezoneFrom(row),
    now: context.now,
    occurrenceOf: context.occurrenceOf,
  })]));
}

// ── Settling what is open ─────────────────────────────────────────────────────

type Verdict = { keep: true } | { keep: false; note: string };
const KEEP: Verdict = { keep: true };
const LEFT_MANAGEMENT = 'Auto-resolved: vendor updates no longer manage this device';

/** What overdue and run failing share: a finished run or leaving management settles either. */
function unfinishedRunVerdict(
  alert: OpenOemAlert,
  row: SweepRow | undefined,
  classified: OemClassification | undefined,
): Verdict {
  if (!row || !classified) return { keep: false, note: LEFT_MANAGEMENT };
  // At result time, so a run dispatched before the alert and answered after it counts.
  if (row.lastSuccessAt && row.lastSuccessAt >= alert.createdAt) {
    return { keep: false, note: 'Auto-resolved: a vendor update run finished' };
  }
  if (classified.state === 'not_supported') return { keep: false, note: LEFT_MANAGEMENT };
  // Still managed with no finished run, into the next occurrence's nights too: not
  // reading overdue right now does not mean it updated. A pause is not an answer
  // either: closing these would also spend the occurrence's one alert.
  if (classified.side.linkEnabled || classified.side.paused) return KEEP;
  return { keep: false, note: LEFT_MANAGEMENT };
}

const SETTLERS: ReadonlyArray<{
  ruleName: string;
  needsState: boolean;
  verdict: (alert: OpenOemAlert, row: SweepRow | undefined, state: OemClassification | undefined) => Verdict;
}> = [
  {
    ruleName: OEM_OVERDUE_RULE_NAME,
    needsState: true,
    verdict: unfinishedRunVerdict,
  },
  {
    ruleName: OEM_RUN_FAILING_RULE_NAME,
    needsState: true,
    verdict: (alert, row, classified) => {
      const verdict = unfinishedRunVerdict(alert, row, classified);
      if (!verdict.keep) return verdict;
      // Null while paused: the schedule cannot say, so the alert waits with the device.
      const current = classified?.side.occurrence?.occurrenceKey;
      return current && current !== alert.dedupeKey
        ? { keep: false, note: 'Auto-resolved: the next vendor update occurrence has started' }
        : KEEP;
    },
  },
  {
    ruleName: OEM_REBOOT_OVERDUE_RULE_NAME,
    needsState: true,
    verdict: (_alert, row, classified) => (row && classified?.state === 'reboot_overdue'
      ? KEEP
      : { keep: false, note: 'Auto-resolved: the restart is no longer overdue' }),
  },
  {
    ruleName: OEM_SCHEDULE_NOT_HANDED_BACK_RULE_NAME,
    needsState: false,
    verdict: (_alert, row) => (row?.reason === OEM_RELEASE_GAVE_UP
      ? KEEP
      : { keep: false, note: "Auto-resolved: the vendor tool's schedule is no longer stuck" }),
  },
  // The result path resolves this as it disarms, and only logs if that fails, after
  // the disarm has committed. Nothing else would come back to it.
  {
    ruleName: OEM_NOT_RETURNED_RULE_NAME,
    needsState: false,
    verdict: (_alert, row) => (row?.returnDeadlineAt
      ? KEEP
      : { keep: false, note: 'Auto-resolved: the device checked in after the vendor update' }),
  },
];

async function settle(settler: (typeof SETTLERS)[number], context: SweepContext): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const open: OpenOemAlert[] = await listOpenOemAlerts(settler.ruleName, cursor, PAGE_SIZE);
    if (open.length === 0) return;

    const ids = [...new Set(open.map((alert) => alert.deviceId))];
    const rows = await loadRows(inArray(devices.id, ids), null);
    const byId = new Map(rows.map((row) => [row.deviceId, row]));
    const states = settler.needsState ? await classifyPage(rows, context) : new Map<string, OemClassification>();

    for (const alert of open) {
      const verdict = settler.verdict(alert, byId.get(alert.deviceId), states.get(alert.deviceId));
      if (verdict.keep) continue;
      // One bad alert must not strand the rest. It stays open, so the next tick tries again.
      try {
        await resolveOemAlert(alert.alertId, verdict.note);
      } catch (error) {
        report(error, alert.orgId, `resolving alert ${alert.alertId}`);
      }
    }

    if (open.length < PAGE_SIZE) return;
    after = open[open.length - 1]!.alertId;
  }
}

// ── Raising what is new ───────────────────────────────────────────────────────

type Raise = { row: SweepRow; dedupeKey: string };

/**
 * What is left after what has already been said. Open under any key: that alert is still
 * standing, and asking `createAlert` would have it refuse on every tick until someone
 * closes it. Closed under this key: said once, and a tech has dealt with it.
 */
async function notYetAlerted(ruleName: string, raises: Raise[]): Promise<Raise[]> {
  if (raises.length === 0) return [];
  const prior = await priorOemAlerts(ruleName, raises.map(({ row }) => row.deviceId));
  const standing = new Set(prior.filter((alert) => alert.open).map((alert) => alert.deviceId));
  const said = new Set(prior.map((alert) => `${alert.deviceId}|${alert.dedupeKey}`));
  return raises.filter(({ row, dedupeKey }) => !standing.has(row.deviceId) && !said.has(`${row.deviceId}|${dedupeKey}`));
}

async function raiseAll(
  ruleName: string,
  raises: Raise[],
  context: SweepContext,
  emit: (raise: Raise) => Promise<string | null>,
): Promise<number> {
  let raised = 0;
  for (const raise of await notYetAlerted(ruleName, raises)) {
    if (context.remaining <= 0) break;
    const orgKey = `${ruleName}|${raise.row.orgId}`;
    // Once per org and rule: a switched-off rule would otherwise cost a round of reads
    // per device on every tick, and use up the cap for orgs that want their alerts.
    let off = context.switchedOff.get(orgKey);
    if (off === undefined) {
      off = await oemRuleSwitchedOff(raise.row.orgId, ruleName);
      context.switchedOff.set(orgKey, off);
    }
    if (off) continue;

    context.remaining -= 1;
    context.lastAttempted = raise.row.deviceId;
    try {
      if (await emit(raise)) raised += 1;
    } catch (error) {
      report(error, raise.row.orgId, `raising "${ruleName}" for device ${raise.row.deviceId}`);
    }
  }
  return raised;
}

/** Where each step stopped when it hit its cap. In memory: a restart just starts over. */
const resumeAfter = new Map<string, string>();

export function resetOemOverdueCursorsForTests(): void {
  resumeAfter.clear();
}

async function raiseFromPages(
  ruleName: string,
  where: SQL | undefined,
  context: SweepContext,
  pick: (page: SweepRow[]) => Promise<void>,
): Promise<void> {
  context.remaining = maxDispatchPerTick();
  context.lastAttempted = null;
  let after: string | null = resumeAfter.get(ruleName) ?? null;
  for (;;) {
    const cursor: string | null = after;
    const page: SweepRow[] = await loadRows(where, cursor);
    await pick(page);
    if (context.remaining <= 0) {
      resumeAfter.set(ruleName, context.lastAttempted!);
      return;
    }
    if (page.length < PAGE_SIZE) {
      resumeAfter.delete(ruleName);
      return;
    }
    after = page[page.length - 1]!.deviceId;
  }
}

/** Devices a policy could be running. Null when none: the flag is off, or nothing is armed. */
async function managedDevices(): Promise<SQL | null> {
  if (!oemUpdatesFlagOn()) return null;
  const scope = await withSystemDbAccessContext(() => armedScope());
  if (!scope) return null;
  // An offline machine stays in: a laptop asleep every night is exactly who this is for.
  return and(
    scope,
    eq(devices.osType, 'windows'),
    eq(devices.isVirtual, false),
    ne(devices.deviceRole, 'server'),
  )!;
}

async function raiseOverdue(context: SweepContext): Promise<number> {
  const where = await managedDevices();
  if (!where) return 0;
  let raised = 0;
  await raiseFromPages(OEM_OVERDUE_RULE_NAME, where, context, async (page) => {
    const states = await classifyPage(page, context);
    const raises = page.flatMap((row): Raise[] => {
      const classified = states.get(row.deviceId);
      const occurrence = classified?.side.occurrence;
      return classified?.state === 'overdue' && occurrence ? [{ row, dedupeKey: occurrence.occurrenceKey }] : [];
    });
    raised += await raiseAll(OEM_OVERDUE_RULE_NAME, raises, context, ({ row, dedupeKey }) => emitOverdueAlert({
      deviceId: row.deviceId,
      orgId: row.orgId,
      occurrenceKey: dedupeKey,
    }));
  });
  return raised;
}

/**
 * The occurrence this device owes an alert for, or null. Attempts used up already reads
 * `overdue`, and past the last night no other retry exists, so the state settles both. The
 * status row's key moves only with a scheduled run, so a failure from an earlier month is
 * not this one's. A policy armed after the last night opened gave the run no further chance.
 */
function runFailingOccurrence(row: SweepRow, classified: OemClassification | undefined): string | null {
  const occurrence = classified?.side.occurrence;
  if (classified?.state !== 'failing' || !occurrence?.isPastLastNight) return null;
  if (row.occurrenceKey !== occurrence.occurrenceKey || row.lastTrigger !== 'scheduled') return null;
  return hadAChanceAtLastNight(classified.side.managedSince, occurrence) ? occurrence.occurrenceKey : null;
}

async function raiseRunFailing(context: SweepContext): Promise<number> {
  const managed = await managedDevices();
  if (!managed) return 0;
  let raised = 0;
  const where = and(managed, inArray(deviceOemUpdateStatus.lastOutcome, [...FAILING_OUTCOMES]));
  await raiseFromPages(OEM_RUN_FAILING_RULE_NAME, where, context, async (page) => {
    const states = await classifyPage(page, context);
    const raises = page.flatMap((row): Raise[] => {
      const occurrenceKey = runFailingOccurrence(row, states.get(row.deviceId));
      return occurrenceKey ? [{ row, dedupeKey: occurrenceKey }] : [];
    });
    raised += await raiseAll(OEM_RUN_FAILING_RULE_NAME, raises, context, ({ row, dedupeKey }) => emitRunFailingAlert({
      deviceId: row.deviceId,
      orgId: row.orgId,
      occurrenceKey: dedupeKey,
      lastOutcome: row.lastOutcome,
      commandId: row.lastCommandId,
    }));
  });
  return raised;
}

async function raiseRebootOverdue(context: SweepContext): Promise<number> {
  let raised = 0;
  const cutoff = new Date(context.now.getTime() - OEM_REBOOT_OVERDUE_NIGHTS * DAY_MS);
  await raiseFromPages(OEM_REBOOT_OVERDUE_RULE_NAME, lte(deviceOemUpdateStatus.rebootPendingSince, cutoff), context, async (page) => {
    const states = await classifyPage(page, context);
    const raises = page.flatMap((row): Raise[] => (
      states.get(row.deviceId)?.state === 'reboot_overdue' && row.rebootPendingSince
        ? [{ row, dedupeKey: row.rebootPendingSince.toISOString() }]
        : []
    ));
    raised += await raiseAll(OEM_REBOOT_OVERDUE_RULE_NAME, raises, context, ({ row, dedupeKey }) => emitRebootOverdueAlert({
      deviceId: row.deviceId,
      orgId: row.orgId,
      pendingSince: dedupeKey,
    }));
  });
  return raised;
}

async function raiseScheduleNotHandedBack(context: SweepContext): Promise<number> {
  let raised = 0;
  const where = and(eq(deviceOemUpdateStatus.reason, OEM_RELEASE_GAVE_UP), isNotNull(deviceOemUpdateStatus.lane));
  await raiseFromPages(OEM_SCHEDULE_NOT_HANDED_BACK_RULE_NAME, where, context, async (page) => {
    // Keyed on the run that took the schedule over: another give-up needs another takeover.
    const raises = page.map((row): Raise => ({ row, dedupeKey: row.lastAttemptAt?.toISOString() ?? 'none' }));
    raised += await raiseAll(OEM_SCHEDULE_NOT_HANDED_BACK_RULE_NAME, raises, context, ({ row, dedupeKey }) => emitScheduleNotHandedBackAlert({
      deviceId: row.deviceId,
      orgId: row.orgId,
      lane: row.statusLane,
      takeoverKey: dedupeKey,
    }));
  });
  return raised;
}

export async function runOemOverdueSweep(now: Date): Promise<void> {
  const context = sweepContext(now);

  // Each step alone: a broken one must not stop the others, on this stage's own terms.
  for (const settler of SETTLERS) {
    try {
      await settle(settler, context);
    } catch (error) {
      report(error, null, `settling "${settler.ruleName}"`);
    }
  }

  let raised = 0;
  const steps: ReadonlyArray<readonly [string, (at: SweepContext) => Promise<number>]> = [
    ['restart overdue', raiseRebootOverdue],
    ['schedule not handed back', raiseScheduleNotHandedBack],
    ['device overdue', raiseOverdue],
    ['run failing', raiseRunFailing],
  ];
  for (const [name, step] of steps) {
    try {
      raised += await step(context);
    } catch (error) {
      report(error, null, `raising ${name}`);
    }
  }
  if (raised > 0) console.log('[OemUpdates] overdue sweep', { raised });
}
