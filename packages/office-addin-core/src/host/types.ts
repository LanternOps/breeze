/**
 * HostAdapter — the seam between the host-NEUTRAL add-in core (auth, chat state
 * machine, approval queue, history, DLP-aware UI) and the host-BOUND surface
 * that actually touches a specific Office application's object model.
 *
 * There are four implementations, one per Office host, each living in its own
 * add-in app rather than beside this file: apps/excel-addin/src/host/excel.ts,
 * apps/word-addin/src/host/word.ts, apps/powerpoint-addin/src/host/powerpoint.ts,
 * and apps/outlook-addin/src/host/outlook.ts. The point of the seam is that
 * adding (or changing) a host means writing/editing an adapter, not editing the
 * core: the core consumes each adapter through this interface and never imports
 * `Excel.*` / `Word.*` / `PowerPoint.*` / the Outlook mailbox API directly.
 *
 * Naming is deliberately host-NEUTRAL so the same shape fits the mail model too:
 *   - `captureContext(kind)` → a cell selection / used range (Excel) OR an email
 *     thread / draft body (Outlook). The wire type is the generic
 *     `WorkbookContext` (a misnomer kept for wire-contract compatibility — it is
 *     really "the per-message context payload", not strictly a workbook).
 *   - `buildPreview(...)` → a before/after grid (Excel write) OR a draft-reply
 *     diff (Outlook). Both collapse to the generic `WritePreview` union.
 *   - `toolExecutors` / `mutatingTools` → the per-host tool layer; the registry
 *     shape (and the approval/DLP machinery around it) is identical across hosts.
 */
import type {
  ToolExecutor,
  WorkbookContext,
  WorkbookContextKind,
  WritePreview,
} from '../api/types';
import type { QuickAction } from '../chat/quickActions';

export type HostAdapter = {
  /**
   * Capture the per-message context the user chose to share (selection / sheet /
   * none for Excel). Must never throw in a way that blocks sending — callers
   * already treat a thrown/undefined result as "no context".
   */
  captureContext: (kind: WorkbookContextKind) => Promise<WorkbookContext | undefined>;
  /**
   * Capture a human label for the active document (Excel: the workbook file
   * name) used to tag the per-user history list. Returns undefined when it can't
   * be read — capture must never block session creation.
   */
  captureName: () => Promise<string | undefined>;
  /** The host's tool layer, keyed by wire tool name. */
  toolExecutors: Record<string, ToolExecutor>;
  /** Wire names of the tools that mutate the document (approval-gated). */
  mutatingTools: ReadonlySet<string>;
  /** Build the before/after preview card for a mutating tool request. */
  buildPreview: (toolName: string, input: Record<string, unknown>) => Promise<WritePreview>;
  /**
   * One-shot read of the host's current selection as a human label (Excel: the
   * sheet-qualified range address, e.g. `Sheet1!B2`). Returns undefined when
   * nothing is selected or it can't be read — must never throw in a way that
   * blocks the UI. REQUIRED so the core's selection chip never touches `Excel.*`.
   */
  captureSelectionAddress: () => Promise<string | undefined>;
  /**
   * Subscribe to host context changes; invokes `cb` whenever the active context
   * changes (selection / mailbox item) so the core can re-read via
   * `captureSelectionAddress` (and re-read the context label). Returns an
   * unsubscribe function. For document hosts (Excel/Word/PPT) this fires on
   * selection moves — the impl wires `DocumentSelectionChanged` and returns a
   * no-op unsubscribe (it never removes the handler — see
   * host/excelSelection.ts). For the mail model (Outlook) it fires when the
   * pinned pane's `mailbox.item` is replaced (item switch). REQUIRED: a one-shot
   * capture alone would freeze the live selection chip and, for a pinned mail
   * pane, bind the stale item — both regressions.
   */
  subscribeSelectionChanged: (cb: () => void) => () => void;
  /**
   * OPTIONAL host-specific composer context-picker options. When present, the
   * Composer renders these instead of the Excel defaults
   * (Selection / Whole sheet / No workbook data) — e.g. Outlook supplies
   * "This email" / "No email data". Excel/Word/PowerPoint leave this unset and
   * inherit the workbook-flavored defaults.
   */
  contextOptions?: Array<{ value: WorkbookContextKind; label: string }>;
  /**
   * OPTIONAL host-specific composer input placeholder. When present, the
   * Composer uses it instead of the Excel default ("Ask about this workbook…")
   * — e.g. Outlook supplies "Ask about this email…". Unset hosts inherit the
   * default.
   */
  composerPlaceholder?: string;
  /**
   * OPTIONAL: hide the composer's context-source dropdown entirely. Some hosts
   * have exactly one meaningful context (Outlook: the open message) so the
   * picker is noise — set this and the pane always uses the default context kind
   * ('selection'), with no opt-out control. The live context chip is still
   * shown. Unset hosts (Excel/Word/PowerPoint) render the normal picker.
   */
  hideContextPicker?: boolean;
  /**
   * OPTIONAL host-specific formatter for the composer's context chip (the little
   * pill that echoes what data the next message will share). When present, the
   * Composer calls this INSTEAD of its Excel-flavored default — which strips the
   * sheet qualifier from a range and surfaces the sheet name (`Sheet: Budget` /
   * `Selection B2`). That default is wrong for hosts whose selection label is not
   * an Excel address: Word's label is a free-text snippet and Outlook's is the
   * message subject, so running the address parser on them mis-renders any value
   * containing `!`. Called with the live context kind and the host's current
   * selection label (or `undefined` when nothing is selected); must be PURE and
   * never throw. Excel leaves this unset and inherits the address-aware default.
   */
  formatContextChip?: (kind: WorkbookContextKind, selectionLabel: string | undefined) => string;
  /**
   * OPTIONAL host-specific empty-state quick-action chips. When present, the
   * pane uses this to compute the suggestion chips from the captured context
   * INSTEAD of the Excel grid-shape heuristic (`summarizeSelection` →
   * `quickActionsFor`). Word/PowerPoint/Outlook supply a small, host-appropriate
   * set ("Summarize this document", "Draft a reply", …) so non-Excel hosts don't
   * fall back to the spreadsheet-flavored chips. Must be PURE and deterministic
   * — it is called with the best-effort captured context (or `undefined` when
   * capture failed/returned nothing) and must never throw. Excel leaves this
   * unset and inherits the grid heuristic.
   */
  quickActions?: (ctx: WorkbookContext | undefined) => QuickAction[];
};
