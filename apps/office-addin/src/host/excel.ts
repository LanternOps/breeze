/**
 * The Excel HostAdapter: the ONE place that binds the host-neutral core to the
 * `Excel.*` object model. It wires up the EXISTING Excel modules — it does not
 * reimplement them:
 *   - tools/dispatcher  → TOOL_EXECUTORS / MUTATING_TOOLS
 *   - chat/captureContext → captureWorkbookContext / captureWorkbookName
 *   - approval/buildPreview → buildWritePreview
 *
 * A future Word/PowerPoint/Outlook adapter is a sibling file of the same shape;
 * the pane (App/ChatPane) picks the concrete host adapter and injects it.
 */
import { buildWritePreview } from '../approval/buildPreview';
import { captureWorkbookContext, captureWorkbookName } from '../chat/captureContext';
import { MUTATING_TOOLS, TOOL_EXECUTORS } from '../tools/dispatcher';
import type { HostAdapter } from './types';

/**
 * One-shot sheet-qualified address of the current Excel selection (e.g.
 * `Sheet1!B2`). Mirrors the read in the legacy useSelectionAddress hook.
 * Never throws — a failed read resolves to undefined ("no selection").
 */
async function captureSelectionAddress(): Promise<string | undefined> {
  try {
    return await Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      range.load('address');
      await context.sync();
      return range.address;
    });
  } catch {
    return undefined;
  }
}

/**
 * Subscribe to Excel's DocumentSelectionChanged so the core can re-read the
 * selection address on every change. Intentionally never removes the handler —
 * the subscriber (the always-mounted Composer) guards late updates itself — so
 * the returned unsubscribe is a no-op, preserving the legacy behavior.
 */
function subscribeSelectionChanged(cb: () => void): () => void {
  const officeGlobal = (globalThis as { Office?: typeof Office }).Office;
  officeGlobal?.context?.document?.addHandlerAsync(
    officeGlobal.EventType.DocumentSelectionChanged,
    cb,
    () => undefined,
  );
  return () => undefined;
}

export const excelHostAdapter: HostAdapter = {
  captureContext: captureWorkbookContext,
  captureName: captureWorkbookName,
  toolExecutors: TOOL_EXECUTORS,
  mutatingTools: MUTATING_TOOLS,
  buildPreview: buildWritePreview,
  captureSelectionAddress,
  subscribeSelectionChanged,
};
