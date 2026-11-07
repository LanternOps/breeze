import { withDbAccessContext } from '../../db';
import type { PendingLink, TicketImportRunPhase } from '../../db/schema';
import { createAuditLogAsync } from '../auditService';
import { captureException } from '../sentry';
import { MigrationWindowError } from '../migrationWindows';
import { parseImportedTicket, type ImportedTicket } from './importedTicket';
import { ticketImportLimits, type TicketImportLimits } from './importLimits';
import { ImportAttachmentFetchError, importErrorTicketId, importTicket, type FetchImportAttachment } from './importWriter';
import { contactLookupContext, eligibleUsersByEmail, keysWithRef, singleContactsByEmail } from './conversionLookups';
import type { AnyTicketImportModule, ConversionContext, ImportedLink, LoadedTicket, SourceHandle, SourceRow } from './moduleContract';
import { getTicketImportModule } from './moduleRegistry';
import { normalizeCursor, SOURCE_FAILURE_LIMIT, type RunCursor } from './runCursor';
import {
  claimSlice,
  commitSlice,
  loadRun,
  readItems,
  readItemsWithPendingLinks,
  readSourceMaps,
  readUnseenImported,
  runContext,
  SliceSupersededError,
  type ItemRow,
  type ItemWrite,
  type SliceRun,
  type SourceMaps,
} from './runLedger';
import {
  applyNotes,
  clampTicketTimes,
  classifyImportError,
  classifySourceError,
  conversionIdentityViolation,
  importedTicketBytes,
  isInfrastructureError,
  predictTicket,
  recordImportResult,
  versionKey,
  type IssueTarget,
} from './runOutcomes';
import { IssueBuffer, normalizeCounters, type RunCounters, type RunIssue } from './runReport';
import { openSourceCredentials } from './sourceCredentials';
import { SourceAuthError, SourceHttpError, SourceResponseTooLargeError, SourceUnavailableError, type SourceClient } from './sourceFetch';
import { buildSourceHandle } from './sourceHandle';
import { readSourceForUse } from './sourceStore';
import { readWindowDescriptor, type WindowDescriptor } from './windowLock';

/**
 * One slice of an import run (#8313 W4; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §5.8, §5.9). A slice works for at most TICKET_IMPORT_SLICE_MS, then hands
 * the run to slice seq + 1 with a compare-and-set on `slice_seq` in the same
 * transaction that saves its position; the worker enqueues the successor. A
 * slice whose seq is no longer the run's exits (`superseded`).
 *
 * The passes (§5.9): scan, one source page at a time (no org, unchanged,
 * removed or merged in Breeze, else load / convert / importTicket); links
 * (only with an import-mode link writer, W2); deletions (probe each imported
 * ticket this run did not see; only after a complete scan); done. A dry run
 * is the scan with every conversion and `parseImportedTicket`, with no
 * window, no ticket writes, no downloads and no ledger writes.
 *
 * Contexts: `importTicket` runs with no context (F1); the ledger, counters and
 * issues in `runContext` (partner scope, no orgs, no user); users by email in
 * system scope with a partner predicate; contacts read-only in a context
 * limited to the run's orgs; refs in system scope.
 *
 * Nothing here merges tickets (#8972): a ticket merged in Breeze is answered
 * `merged_in_breeze` by the writer and stays final.
 */

/** The import-mode link writer of W2 (`importTicketLink`), behind an interface until it ships. */
export type ImportLinkWriter = {
  writeLink(
    windowId: string,
    link: Omit<ImportedLink, 'at'> & { at: Date },
    options: { partnerId: string },
  ): Promise<{ outcome: 'written' | 'already' | 'not_written'; code?: string; retry?: boolean }>;
};

export type SliceInput = { runId: string; partnerId: string; seq: number };

export type SliceDeps = {
  now?: () => Date;
  limits?: TicketImportLimits;
  importTicket?: typeof importTicket;
  /** W2's writer; absent until then, so every link stays the conversion's note. */
  linkWriter?: ImportLinkWriter | null;
  /** Tests inject a client per base URL. */
  httpFor?: (baseUrl: string) => SourceClient;
  /** Polled at every ticket boundary: true when the lease was lost or the process is stopping. */
  shouldYield?: () => boolean;
};

export type SliceOutcome =
  /** This slice does not own the run (its successor ran, or the run ended). */
  | { kind: 'superseded'; sliceSeq: number | null; active: boolean }
  /** The run moved to slice seq + 1; enqueue it. */
  | { kind: 'continue' }
  | { kind: 'finished'; state: 'completed' | 'stopped' | 'failed'; stopReason: string | null }
  /** Delay this same slice (a 429, a source Retry-After): spends no attempt. */
  | { kind: 'defer'; delayMs: number; reason: string };

type Step =
  | { kind: 'progress' }
  | { kind: 'yield' }
  | { kind: 'stop'; reason: string; state?: 'stopped' | 'failed' }
  | { kind: 'defer'; delayMs: number; reason: string };

type EndStep = Exclude<Step, { kind: 'progress' }>;
type RowResult = { kind: 'done'; slow: boolean } | Exclude<Step, { kind: 'progress' } | { kind: 'yield' }>;

const DELETIONS_BATCH = 50;
const LINKS_BATCH = 50;
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

function sourceBackoffMs(failures: number): number {
  return Math.min(5 * 60_000, 10_000 * 2 ** Math.max(0, failures - 1));
}

export async function runSlice(input: SliceInput, deps: SliceDeps = {}): Promise<SliceOutcome> {
  const ctx = runContext(input.partnerId);
  const run = await withDbAccessContext(ctx, () => loadRun(input.partnerId, input.runId));
  if (!run) return { kind: 'superseded', sliceSeq: null, active: false };
  const active = run.state === 'queued' || run.state === 'running';
  if (run.sliceSeq !== input.seq || !active) return { kind: 'superseded', sliceSeq: run.sliceSeq, active };
  const token = await withDbAccessContext(ctx, () => claimSlice(input.partnerId, input.runId, input.seq));
  if (!token) return { kind: 'superseded', sliceSeq: null, active: true };
  const runner = new SliceRunner(input, run, token, deps);
  try {
    return await runner.execute();
  } catch (error) {
    if (error instanceof SliceSupersededError) return { kind: 'superseded', sliceSeq: null, active: false };
    throw error;
  }
}

class SliceRunner {
  private readonly now: () => Date;
  private readonly limits: TicketImportLimits;
  private readonly startedAt: number;
  private readonly cursor: RunCursor;
  private readonly counters: RunCounters;
  private readonly issues: IssueBuffer;
  private readonly dryRun: boolean;
  private phase: TicketImportRunPhase;
  private pending: ItemWrite[] = [];
  /** owner_unmatched rows for the next commit (deduplicated there, review #13). */
  private ownerIssues: RunIssue[] = [];
  private progressed = false;
  /**
   * Set by the attachment reader when a file's failure means more than that
   * ticket (review #7): the credential was refused (stop the run), or the
   * source asked to wait (defer the slice; the ticket resumes from the same
   * cursor position). importTicket only sees a transient failure.
   */
  private attachmentSignal: { kind: 'stop'; reason: string } | { kind: 'defer'; delayMs: number } | null = null;

  private takeAttachmentSignal(): { kind: 'stop'; reason: string } | { kind: 'defer'; delayMs: number } | null {
    const signal = this.attachmentSignal;
    this.attachmentSignal = null;
    return signal;
  }
  private module!: AnyTicketImportModule;
  private src!: SourceHandle;
  private maps!: SourceMaps;
  private window: WindowDescriptor | null = null;
  private principalId!: string;
  private contactOrgIds: string[] = [];

  constructor(
    private readonly input: SliceInput,
    private readonly run: SliceRun,
    /** This execution's claim (review #10): every commit presents it. */
    private readonly claimToken: string,
    private readonly deps: SliceDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
    this.limits = deps.limits ?? ticketImportLimits();
    this.startedAt = this.now().getTime();
    this.cursor = normalizeCursor(run.cursor);
    this.counters = normalizeCounters(run.counters);
    this.issues = new IssueBuffer(this.counters, this.limits.maxIssuesPerRun);
    this.dryRun = run.kind === 'dry_run';
    this.phase = run.phase;
  }

  async execute(): Promise<SliceOutcome> {
    const setup = await this.setup();
    if (setup) return this.end(setup);
    for (;;) {
      if (this.phase === 'done') return this.finish('completed', null);
      if (this.timeUp()) return this.end({ kind: 'yield' });
      let step: Step;
      if (this.phase === 'scan') step = await this.scanPage();
      else if (this.phase === 'links') step = await this.linksStep();
      else step = await this.deletionsStep();
      if (step.kind !== 'progress') return this.end(step);
    }
  }

  // ---------------------------------------------------------------- setup

  private async setup(): Promise<EndStep | null> {
    const ctx = runContext(this.input.partnerId);
    const source = await withDbAccessContext(ctx, () => readSourceForUse(this.input.partnerId, this.run.sourceId));
    if (!source) return { kind: 'stop', reason: 'source_missing', state: 'failed' };
    if (!source.credentialsEncrypted) return { kind: 'stop', reason: 'credentials_revoked' };
    const module = getTicketImportModule(source.view.module);
    if (!module) return { kind: 'stop', reason: 'module_unavailable', state: 'failed' };
    const options = module.optionsSchema.safeParse(this.run.options ?? {});
    if (!options.success) return { kind: 'stop', reason: 'invalid_options', state: 'failed' };
    let credentials;
    try {
      credentials = openSourceCredentials(source.view.id, source.credentialsEncrypted);
    } catch {
      return { kind: 'stop', reason: 'credentials_unreadable', state: 'failed' };
    }
    this.module = module;
    this.principalId = source.view.principalId;
    this.maps = await withDbAccessContext(ctx, () => readSourceMaps(this.input.partnerId, this.run.sourceId));
    if (!this.dryRun) {
      try {
        this.window = await readWindowDescriptor(this.run.windowId!, this.input.partnerId);
      } catch (error) {
        if (error instanceof MigrationWindowError && error.code === 'MIGRATION_WINDOW_NOT_OPEN') return { kind: 'stop', reason: 'window_closed' };
        throw error;
      }
      if (this.window.principalId !== this.principalId) return { kind: 'stop', reason: 'window_principal_mismatch' };
      this.contactOrgIds = this.window.orgIds;
    } else {
      this.contactOrgIds = [...new Set([...this.maps.orgIdBySourceOrg.values(), ...(this.maps.fallbackOrgId ? [this.maps.fallbackOrgId] : [])])];
    }
    this.src = buildSourceHandle({
      sourceId: source.view.id,
      baseUrl: source.view.baseUrl,
      credentials,
      options: options.data,
      ...(this.deps.httpFor ? { http: this.deps.httpFor(source.view.baseUrl) } : {}),
    });
    // The clock skew is measured once per run, at its first connect (§5.2).
    if (this.cursor.clockSkewMs === undefined) {
      try {
        this.cursor.clockSkewMs = (await this.module.connect(this.src)).clockSkewMs;
        this.cursor.sourceFailures = 0;
      } catch (error) {
        return this.pageSourceTrouble(error);
      }
    }
    return null;
  }

  // ----------------------------------------------------------- commits

  /**
   * The slice's budget is spent (it always does one unit of work first, so a
   * run advances whatever the budget), or the lease was lost or the process
   * is stopping (then it hands over at once).
   */
  private timeUp(): boolean {
    if (this.deps.shouldYield?.()) return true;
    return this.progressed && this.now().getTime() - this.startedAt >= this.limits.sliceMs;
  }

  private stage(item: ItemWrite): void {
    if (!this.dryRun) this.pending.push(item);
  }

  private async commit(extra: { advance?: boolean; finish?: { state: 'completed' | 'stopped' | 'failed'; stopReason: string | null }; resumeAt?: Date } = {}): Promise<void> {
    const items = this.pending;
    this.pending = [];
    const ownerIssues = this.ownerIssues;
    this.ownerIssues = [];
    const result = await withDbAccessContext(runContext(this.input.partnerId), () => commitSlice(this.input.partnerId, this.input.runId, this.input.seq, this.claimToken, {
      sourceId: this.run.sourceId,
      phase: this.phase,
      cursor: this.cursor as unknown as Record<string, unknown>,
      counters: this.counters as unknown as Record<string, unknown>,
      items,
      issues: this.issues.take(),
      ownerIssues,
      ...extra,
    }));
    this.counters.ownersUnmatched += result.ownersInserted;
  }

  private async end(step: EndStep): Promise<SliceOutcome> {
    switch (step.kind) {
      case 'yield':
        await this.commit({ advance: true });
        return { kind: 'continue' };
      case 'defer':
        // When the slice is due back: a sign of life for the stalled-run sweep.
        await this.commit({ resumeAt: new Date(this.now().getTime() + step.delayMs) });
        return { kind: 'defer', delayMs: step.delayMs, reason: step.reason };
      case 'stop':
        return this.finish(step.state ?? 'stopped', step.reason);
    }
  }

  private async finish(state: 'completed' | 'stopped' | 'failed', stopReason: string | null): Promise<SliceOutcome> {
    if (state === 'completed') this.phase = 'done';
    await this.commit({ finish: { state, stopReason } });
    void createAuditLogAsync({
      partnerId: this.input.partnerId,
      actorType: 'system',
      actorId: SYSTEM_ACTOR_ID,
      action: 'ticket_import.run_finished',
      resourceType: 'ticket_import_run',
      resourceId: this.input.runId,
      details: { sourceId: this.run.sourceId, kind: this.run.kind, state, stopReason, counters: this.counters },
      result: state === 'completed' ? 'success' : 'failure',
    });
    return { kind: 'finished', state, stopReason };
  }

  // -------------------------------------------------------------- scan

  private async scanPage(): Promise<Step> {
    let page: { rows: SourceRow[]; next: unknown };
    try {
      page = await this.module.scan(this.src, this.cursor.scan.page ?? null);
    } catch (error) {
      return this.pageSourceTrouble(error);
    }
    this.cursor.sourceFailures = 0;
    const rows = page.rows;
    const existing = await withDbAccessContext(runContext(this.input.partnerId), () =>
      readItems(this.input.partnerId, this.run.sourceId, rows.map((r) => r.key)));
    // One batched ref lookup per page (review #14): the changed items that ever
    // had a ticket, and on a dry run every row (create or resume).
    const refKeys = rows.filter((r) => this.dryRun || this.needsRefCheck(r, existing.get(r.key))).map((r) => r.key);
    const refs = refKeys.length > 0 ? await keysWithRef(this.principalId, refKeys) : new Set<string>();
    // A key a source lists twice in one page is processed once, the first
    // time (review #8); keys of rows done before a crash count as handled.
    const handled = new Set(rows.slice(0, this.cursor.scan.index).map((r) => r.key));
    for (let i = this.cursor.scan.index; i < rows.length; i += 1) {
      if (this.timeUp()) return { kind: 'yield' };
      if (handled.has(rows[i]!.key)) {
        this.cursor.scan.index = i + 1;
        continue;
      }
      handled.add(rows[i]!.key);
      const result = await this.processRow(rows[i]!, existing.get(rows[i]!.key), refs);
      if (result.kind !== 'done') return result;
      this.cursor.scan.index = i + 1;
      if (result.slow) await this.commit();
      this.progressed = true;
    }
    this.progressed = true;
    this.cursor.scan = { page: page.next, index: 0, done: page.next === null };
    if (this.cursor.scan.done) {
      this.phase = this.dryRun ? 'done' : this.deps.linkWriter ? 'links' : 'deletions';
    }
    await this.commit();
    return { kind: 'progress' };
  }

  /**
   * A changed item that ever had a Breeze ticket (imported, or begun and then
   * failed): does this principal's ref still exist? (§5.9, review #2)
   */
  private needsRefCheck(row: SourceRow, item: ItemRow | undefined): boolean {
    if (!item || (item.breezeTicketId === null && item.importedVersion === null)) return false;
    if (item.state === 'removed_in_breeze' || item.state === 'merged_in_breeze') return false;
    return !(item.state === 'imported' && item.importedVersion === versionKey(row.version));
  }

  private resolveOrg(orgKey: string | null): string | null {
    if (orgKey !== null) {
      const mapped = this.maps.orgIdBySourceOrg.get(orgKey);
      if (mapped) return mapped;
    }
    return this.maps.fallbackOrgId;
  }

  private async processRow(row: SourceRow, item: ItemRow | undefined, refs: Set<string> | null): Promise<RowResult> {
    const target: IssueTarget = { key: row.key, number: row.number ?? null };
    const seen = { seenVersion: versionKey(row.version), seenRunId: this.input.runId };
    // Already handled by this run (a page re-read after a crash or a shift).
    if (!this.dryRun && item && item.seenRunId === this.input.runId && item.seenVersion === seen.seenVersion) {
      return { kind: 'done', slow: false };
    }
    this.counters.tickets.seen += 1;
    // Final: a change made in Breeze wins, whatever the version (§5.9).
    if (item && (item.state === 'removed_in_breeze' || item.state === 'merged_in_breeze')) {
      this.counters.tickets.skipped += 1;
      this.stage({ ...item, ...seen });
      return { kind: 'done', slow: false };
    }
    const orgId = this.resolveOrg(row.orgKey);
    if (!orgId) {
      this.counters.tickets.skipped += 1;
      this.issues.add({ sourceTicketKey: target.key, sourceTicketNumber: target.number, kind: 'skipped_no_org', code: null });
      this.stage(this.itemOf(row, item, { state: 'skipped', failureCode: 'no_org' }));
      return { kind: 'done', slow: false };
    }
    if (item && item.state === 'imported' && item.importedVersion === seen.seenVersion) {
      this.counters.tickets.unchanged += 1;
      this.stage({ ...item, ...seen });
      return { kind: 'done', slow: false };
    }
    if (this.needsRefCheck(row, item)) {
      const present = refs ?? await keysWithRef(this.principalId, [row.key]);
      if (!present.has(row.key)) {
        // Hard-deleted in Breeze or its org erased: never imported again.
        this.counters.removedInBreeze += 1;
        this.counters.tickets.skipped += 1;
        this.issues.add({ sourceTicketKey: target.key, sourceTicketNumber: target.number, kind: 'removed_in_breeze', code: null });
        this.stage({ ...item!, ...seen, state: 'removed_in_breeze', failureCode: null });
        return { kind: 'done', slow: false };
      }
    }
    return this.loadAndImport(row, item, orgId, target, refs);
  }

  private itemOf(row: SourceRow, item: ItemRow | undefined, change: Partial<ItemWrite> & Pick<ItemWrite, 'state'>): ItemWrite {
    return {
      sourceTicketKey: row.key,
      importedVersion: item?.importedVersion ?? null,
      seenVersion: versionKey(row.version),
      seenRunId: this.input.runId,
      breezeTicketId: item?.breezeTicketId ?? null,
      pendingLinks: item?.pendingLinks ?? null,
      failureCode: null,
      attempts: item?.attempts ?? 0,
      ...change,
    };
  }

  /**
   * Records the Breeze ticket of a ticket the writer began but did not finish
   * (a stop or a deferral mid-ticket), leaving the rest of the item as it was,
   * so a later pass knows the ticket existed even if it is deleted meanwhile.
   */
  private rememberTicket(row: SourceRow, item: ItemRow | undefined, ticketId: string | null): void {
    if (!ticketId) return;
    this.stage({
      ...(item ?? {
        sourceTicketKey: row.key,
        state: 'failed',
        importedVersion: null,
        seenVersion: null,
        seenRunId: null,
        failureCode: 'incomplete',
        attempts: 0,
        breezeTicketId: null,
        pendingLinks: null,
      }),
      breezeTicketId: ticketId,
    });
  }

  /** An unexpected error confined to one ticket: logged and reported, never rethrown. */
  private reportTicketFault(error: unknown, key: string, stage: string): void {
    console.warn('[ticketImport] ticket failed', { runId: this.input.runId, key, stage, error: error instanceof Error ? error.name : 'unknown' });
    captureException(error, undefined, { service: 'ticketImport', stage });
  }

  private failItem(row: SourceRow, item: ItemRow | undefined, target: IssueTarget, code: string, ticketId: string | null = null): RowResult {
    this.counters.tickets.failed += 1;
    this.issues.add({ sourceTicketKey: target.key, sourceTicketNumber: target.number, kind: 'failed', code: code.slice(0, 64) });
    this.stage(this.itemOf(row, item, {
      state: 'failed',
      failureCode: code.slice(0, 64),
      attempts: (item?.attempts ?? 0) + 1,
      breezeTicketId: ticketId ?? item?.breezeTicketId ?? null,
    }));
    return { kind: 'done', slow: true };
  }

  private async loadAndImport(
    row: SourceRow,
    item: ItemRow | undefined,
    orgId: string,
    target: IssueTarget,
    refs: Set<string> | null,
  ): Promise<RowResult> {
    // The quick decisions so far commit before the slow work.
    if (this.pending.length > 0) await this.commit();
    let loaded: LoadedTicket;
    try {
      loaded = await this.module.load(this.src, row);
    } catch (error) {
      return this.ticketSourceTrouble(error, row, item, target);
    }
    this.cursor.sourceFailures = 0;
    const context = await this.conversionContext(orgId, loaded);
    let conversion;
    try {
      conversion = this.module.convert(loaded, context);
    } catch (error) {
      this.reportTicketFault(error, row.key, 'convert');
      return this.failItem(row, item, target, 'conversion_error');
    }
    // A conversion must import the ticket its row names (§5.2 ids).
    if (conversionIdentityViolation(conversion, row.key)) return this.failItem(row, item, target, 'module_contract_violation');
    applyNotes(conversion.notes, this.counters, this.issues, this.ownerIssues, target);
    if (conversion.kind === 'skip') {
      this.counters.tickets.skipped += 1;
      this.issues.add({
        sourceTicketKey: target.key,
        sourceTicketNumber: target.number,
        kind: conversion.code === 'no_org' ? 'skipped_no_org' : 'skipped_unsupported',
        code: conversion.code,
      });
      this.stage(this.itemOf(row, item, { state: 'skipped', failureCode: conversion.code }));
      return { kind: 'done', slow: true };
    }
    const issueTarget = { key: target.key, number: conversion.ticket.sourceNumber ?? target.number };
    const clamped = clampTicketTimes(conversion.ticket, this.now(), this.limits.maxClockSkewMs);
    if (clamped.kind === 'clock_skew') return this.failItem(row, item, issueTarget, 'clock_skew');
    if (clamped.clamped) this.counters.clockClamped += 1;
    // The framework decides the org from the maps; a module cannot route elsewhere.
    const ticket = { ...clamped.ticket, orgId };
    if (importedTicketBytes(ticket) > this.limits.maxTicketBytes) return this.failItem(row, item, issueTarget, 'ticket_too_large');

    if (this.dryRun) return this.predict(row, item, ticket, conversion.links.length, issueTarget, refs);

    let result;
    this.attachmentSignal = null;
    try {
      result = await (this.deps.importTicket ?? importTicket)(this.window!.id, ticket, {
        partnerId: this.input.partnerId,
        isSourceArticleId: (id) => this.module.isSourceArticleId(id),
        fetchAttachment: this.attachmentFetcher(row.key),
      });
    } catch (error) {
      // The ticket the writer had when it failed, if any (review #2).
      const known = importErrorTicketId(error);
      const signal = this.takeAttachmentSignal();
      if (signal) {
        this.rememberTicket(row, item, known);
        if (signal.kind === 'stop') return { kind: 'stop', reason: signal.reason };
        return this.sourceWait(signal.delayMs);
      }
      const failure = classifyImportError(error);
      if (failure.kind === 'failed') return this.failItem(row, item, issueTarget, failure.code, known);
      if (failure.kind === 'stop') {
        this.rememberTicket(row, item, known);
        return { kind: 'stop', reason: failure.reason };
      }
      if (failure.kind === 'defer') {
        this.rememberTicket(row, item, known);
        return { kind: 'defer', delayMs: failure.delayMs, reason: 'window_rate_limited' };
      }
      // Anything else is this ticket's alone (review #1), unless Breeze's own
      // infrastructure failed: then the slice ends and is retried.
      if (isInfrastructureError(error)) throw error;
      this.reportTicketFault(error, row.key, 'import');
      return this.failItem(row, item, issueTarget, 'internal_error', known);
    }
    if (result.outcome === 'skipped' && result.skip?.reason === 'merged_in_breeze') {
      this.counters.mergedInBreeze += 1;
      this.counters.tickets.skipped += 1;
      this.issues.add({ sourceTicketKey: issueTarget.key, sourceTicketNumber: issueTarget.number, kind: 'merged_in_breeze', code: result.skip.mergedIntoTicketId });
      this.stage(this.itemOf(row, item, { state: 'merged_in_breeze', attempts: 0, breezeTicketId: result.ticketId }));
      return { kind: 'done', slow: true };
    }
    recordImportResult(result, this.counters, this.issues, issueTarget);
    // A ticket with links records its version once they are written or known
    // impossible (§6.6); with no link writer they stay the conversion's note.
    let importedVersion: string | null = versionKey(row.version);
    let pendingLinks: PendingLink[] | null = null;
    if (conversion.links.length > 0) {
      if (this.deps.linkWriter) {
        // They wait on the item for the links phase (review #13).
        pendingLinks = conversion.links.map((l) => ({ targetKey: l.targetKey, linkType: l.linkType, at: l.at.toISOString() }));
        importedVersion = item?.importedVersion ?? null;
      } else {
        this.counters.linksAsNotes += conversion.links.length;
      }
    }
    this.stage(this.itemOf(row, item, { state: 'imported', importedVersion, pendingLinks, attempts: 0, breezeTicketId: result.ticketId }));
    return { kind: 'done', slow: true };
  }

  private async predict(
    row: SourceRow,
    item: ItemRow | undefined,
    ticket: ImportedTicket,
    links: number,
    target: IssueTarget,
    refs: Set<string> | null,
  ): Promise<RowResult> {
    try {
      parseImportedTicket(ticket, this.now());
    } catch (error) {
      if (!(error instanceof MigrationWindowError)) {
        this.reportTicketFault(error, row.key, 'parse');
        return this.failItem(row, item, target, 'internal_error');
      }
      this.counters.predicted.invalid += 1;
      return this.failItem(row, item, target, error.code);
    }
    const resumes = (refs ?? await keysWithRef(this.principalId, [row.key])).has(row.key);
    predictTicket(ticket, this.counters, resumes);
    this.counters.linksAsNotes += links;
    return { kind: 'done', slow: true };
  }

  private async conversionContext(orgId: string, loaded: LoadedTicket): Promise<ConversionContext> {
    const [userIdByEmail, contactIdByEmail] = await Promise.all([
      eligibleUsersByEmail(this.input.partnerId, orgId, loaded.needs?.userEmails),
      singleContactsByEmail(contactLookupContext(this.input.partnerId, this.contactOrgIds), orgId, loaded.needs?.contactEmails),
    ]);
    return {
      orgId,
      orgIdBySourceOrg: this.maps.orgIdBySourceOrg,
      fallbackOrgId: this.maps.fallbackOrgId,
      categoryIdBySourceGroup: this.maps.categoryIdBySourceGroup,
      userIdByEmail,
      contactIdByEmail,
      options: this.src.options,
      now: this.now(),
      clockSkewMs: this.cursor.clockSkewMs ?? null,
    };
  }

  /**
   * The module's file reader as importTicket asks for it: a source 404/403 is
   * a permanent `not_found`, an over-cap answer `too_large`, anything else
   * transient (the ticket is retried by the next run, §4.3).
   */
  private attachmentFetcher(ticketKey: string): FetchImportAttachment {
    return async (sourceId, maxBytes) => {
      try {
        return await this.module.fetchAttachment(this.src, { sourceId, ticketKey }, maxBytes);
      } catch (error) {
        if (error instanceof ImportAttachmentFetchError) throw error;
        if (error instanceof SourceHttpError && [403, 404, 410].includes(error.status)) {
          throw new ImportAttachmentFetchError('not_found', undefined, { cause: error });
        }
        if (error instanceof SourceResponseTooLargeError) throw new ImportAttachmentFetchError('too_large', undefined, { cause: error });
        if (error instanceof SourceAuthError) this.attachmentSignal = { kind: 'stop', reason: 'source_unauthorized' };
        else if (error instanceof SourceUnavailableError && error.retryAfterMs !== null) {
          this.attachmentSignal = { kind: 'defer', delayMs: error.retryAfterMs };
        }
        throw new ImportAttachmentFetchError('transient', undefined, { cause: error });
      }
    };
  }

  /** A failed page read or connect (§5.8): stop, or defer this slice. */
  private async pageSourceTrouble(error: unknown): Promise<EndStep> {
    const f = classifySourceError(error);
    if (f.kind === 'unauthorized') return { kind: 'stop', reason: 'source_unauthorized' };
    if (f.kind === 'http') return { kind: 'stop', reason: `source_${f.status}` };
    if (f.kind === 'too_large') return { kind: 'stop', reason: 'source_page_too_large' };
    if (f.kind === 'rethrow') throw error;
    if (f.retryAfterMs !== null) return this.sourceWait(f.retryAfterMs);
    this.cursor.sourceFailures += 1;
    if (this.cursor.sourceFailures >= SOURCE_FAILURE_LIMIT) return { kind: 'stop', reason: 'source_unavailable' };
    return { kind: 'defer', delayMs: sourceBackoffMs(this.cursor.sourceFailures), reason: 'source_unavailable' };
  }

  /**
   * The source asked to wait (`Retry-After`). It counts as a consecutive
   * source failure (review #6), saved in the cursor across slices and reset
   * by the next success, so a source that answers 429 forever stops the run
   * as `source_unavailable` instead of deferring it forever.
   */
  private sourceWait(delayMs: number): Exclude<EndStep, { kind: 'yield' }> {
    this.cursor.sourceFailures += 1;
    if (this.cursor.sourceFailures >= SOURCE_FAILURE_LIMIT) return { kind: 'stop', reason: 'source_unavailable' };
    return { kind: 'defer', delayMs, reason: 'source_retry_after' };
  }

  /** A failed load or probe of one ticket: the ticket fails, unless the source asked to wait or is gone. */
  private ticketSourceTrouble(error: unknown, row: SourceRow, item: ItemRow | undefined, target: IssueTarget): RowResult {
    const f = classifySourceError(error);
    if (f.kind === 'unauthorized') return { kind: 'stop', reason: 'source_unauthorized' };
    if (f.kind === 'rethrow') {
      // A module bug or an unexpected answer: this ticket fails, the run goes on.
      if (isInfrastructureError(error)) throw error;
      this.reportTicketFault(error, row.key, 'source');
      return this.failItem(row, item, target, 'internal_error');
    }
    if (f.kind === 'http') return this.failItem(row, item, target, `source_${f.status}`);
    if (f.kind === 'too_large') return this.failItem(row, item, target, 'ticket_too_large');
    if (f.retryAfterMs !== null) return this.sourceWait(f.retryAfterMs);
    this.cursor.sourceFailures += 1;
    if (this.cursor.sourceFailures >= SOURCE_FAILURE_LIMIT) return { kind: 'stop', reason: 'source_unavailable' };
    return this.failItem(row, item, target, 'source_unavailable');
  }

  /**
   * A probe the source could not answer (review #5). Never a failed ticket:
   * the item was imported and stays so, unseen by this run, with a
   * `probe_deferred` issue, and the next run probes it again. A refused
   * credential stops the run; a `Retry-After` defers the slice; both, and a
   * transient failure, count toward the consecutive source failures.
   */
  private probeTrouble(error: unknown, target: IssueTarget): Exclude<EndStep, { kind: 'yield' }> | null {
    const f = classifySourceError(error);
    let code: string;
    if (f.kind === 'unauthorized') return { kind: 'stop', reason: 'source_unauthorized' };
    if (f.kind === 'unavailable') {
      if (f.retryAfterMs !== null) return this.sourceWait(f.retryAfterMs);
      this.cursor.sourceFailures += 1;
      if (this.cursor.sourceFailures >= SOURCE_FAILURE_LIMIT) return { kind: 'stop', reason: 'source_unavailable' };
      code = 'source_unavailable';
    } else if (f.kind === 'http') {
      code = `source_${f.status}`;
    } else if (f.kind === 'too_large') {
      code = 'response_too_large';
    } else {
      if (isInfrastructureError(error)) throw error;
      this.reportTicketFault(error, target.key, 'probe');
      code = 'internal_error';
    }
    this.issues.add({ sourceTicketKey: target.key, sourceTicketNumber: null, kind: 'probe_deferred', code });
    return null;
  }

  // ------------------------------------------------------------- links

  private async linksStep(): Promise<Step> {
    const writer = this.deps.linkWriter;
    if (!writer) {
      this.phase = 'deletions';
      return { kind: 'progress' };
    }
    const batch = await withDbAccessContext(runContext(this.input.partnerId), () =>
      readItemsWithPendingLinks(this.input.partnerId, this.run.sourceId, this.cursor.links.after, LINKS_BATCH));
    if (batch.length === 0) {
      this.phase = 'deletions';
      await this.commit();
      return { kind: 'progress' };
    }
    for (const item of batch) {
      if (this.timeUp()) return { kind: 'yield' };
      // Final for this version once every link is written, or known impossible
      // (§6.6); a link worth another try leaves the item to be reloaded.
      let final = true;
      for (const link of item.pendingLinks ?? []) {
        let result: Awaited<ReturnType<ImportLinkWriter['writeLink']>>;
        try {
          result = await writer.writeLink(
            this.window!.id,
            { sourceKey: item.sourceTicketKey, targetKey: link.targetKey, linkType: link.linkType, at: new Date(link.at) },
            { partnerId: this.input.partnerId },
          );
        } catch (error) {
          if (isInfrastructureError(error)) throw error;
          this.reportTicketFault(error, item.sourceTicketKey, 'link');
          result = { outcome: 'not_written', code: 'internal_error', retry: true };
        }
        if (result.outcome === 'not_written') {
          this.counters.linksAsNotes += 1;
          this.issues.add({ sourceTicketKey: item.sourceTicketKey, sourceTicketNumber: null, kind: 'link_not_written', code: result.code ?? null });
          if (result.retry === true) final = false;
        } else {
          this.counters.linksWritten += 1;
        }
      }
      this.stage({ ...item, pendingLinks: null, importedVersion: final ? item.seenVersion : item.importedVersion });
      this.cursor.links.after = item.sourceTicketKey;
      await this.commit();
      this.progressed = true;
    }
    return { kind: 'progress' };
  }

  // --------------------------------------------------------- deletions

  private async deletionsStep(): Promise<Step> {
    const batch = await withDbAccessContext(runContext(this.input.partnerId), () => readUnseenImported(
      this.input.partnerId, this.run.sourceId, this.input.runId, this.cursor.deletions.after, DELETIONS_BATCH));
    if (batch.length === 0) {
      this.phase = 'done';
      return { kind: 'progress' };
    }
    for (const item of batch) {
      if (this.timeUp()) return { kind: 'yield' };
      const target: IssueTarget = { key: item.sourceTicketKey, number: null };
      let probe;
      try {
        probe = await this.module.probe(this.src, item.sourceTicketKey);
      } catch (error) {
        const outcome = this.probeTrouble(error, target);
        if (outcome) return outcome;
        // The item stays imported and unseen: the next run probes it again.
        this.cursor.deletions.after = item.sourceTicketKey;
        await this.commit();
        this.progressed = true;
        continue;
      }
      this.cursor.sourceFailures = 0;
      if (probe.state === 'present') {
        // Skipped by an offset shift (Z2): import it now.
        const result = await this.processRow(probe.row, item, null);
        if (result.kind !== 'done') return result;
      } else {
        const deleted = probe.state === 'deleted';
        if (deleted) this.counters.deletedInSource += 1;
        else this.counters.hiddenInSource += 1;
        this.issues.add({ sourceTicketKey: target.key, sourceTicketNumber: null, kind: deleted ? 'deleted_in_source' : 'hidden_in_source', code: null });
        // Nothing is ever deleted in Breeze; the ledger and the report say so.
        this.stage({ ...item, state: deleted ? 'deleted_in_source' : 'hidden_in_source', seenRunId: this.input.runId });
      }
      this.cursor.deletions.after = item.sourceTicketKey;
      await this.commit();
      this.progressed = true;
    }
    return { kind: 'progress' };
  }
}
