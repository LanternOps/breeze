/**
 * HostAdapter — the seam between the host-NEUTRAL add-in core (auth, chat state
 * machine, approval queue, history, DLP-aware UI) and the host-BOUND surface
 * that actually touches a specific Office application's object model.
 *
 * Today there is exactly one implementation (Excel — see ./excel.ts). The point
 * of the seam is that adding Word / PowerPoint / Outlook means writing a new
 * adapter, not editing the core: the core consumes the adapter through this
 * interface and never imports `Excel.*` (or any other host) directly.
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
};
