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
import { captureExcelSelectionAddress, subscribeExcelSelectionChanged } from './excelSelection';
import type { HostAdapter } from '@breeze/office-addin-core';

export const excelHostAdapter: HostAdapter = {
  captureContext: captureWorkbookContext,
  captureName: captureWorkbookName,
  toolExecutors: TOOL_EXECUTORS,
  mutatingTools: MUTATING_TOOLS,
  buildPreview: buildWritePreview,
  captureSelectionAddress: captureExcelSelectionAddress,
  subscribeSelectionChanged: subscribeExcelSelectionChanged,
};
