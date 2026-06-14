/**
 * The PowerPoint HostAdapter: the ONE place that binds the host-neutral core to
 * the `PowerPoint.*` object model. It wires up the PowerPoint modules — it does
 * not reimplement the core:
 *   - tools/dispatcher      → POWERPOINT_TOOL_EXECUTORS / POWERPOINT_MUTATING_TOOLS
 *   - chat/captureContext   → capturePptContext / capturePptName
 *   - approval/buildPreview → buildPptPreview
 *   - host/powerpointSelection → capturePptSelectionLabel / subscribePptSelectionChanged
 *
 * Sibling of host/word.ts and host/excel.ts (same shape); the pane (App/ChatPane)
 * picks the concrete adapter and injects it.
 */
import { buildPptPreview } from '../approval/buildPreview';
import { capturePptContext, capturePptName } from '../chat/captureContext';
import { POWERPOINT_MUTATING_TOOLS, POWERPOINT_TOOL_EXECUTORS } from '../tools/dispatcher';
import { capturePptSelectionLabel, subscribePptSelectionChanged } from './powerpointSelection';
import type { HostAdapter } from '@breeze/office-addin-core';

export const powerpointHostAdapter: HostAdapter = {
  captureContext: capturePptContext,
  captureName: capturePptName,
  toolExecutors: POWERPOINT_TOOL_EXECUTORS,
  mutatingTools: POWERPOINT_MUTATING_TOOLS,
  buildPreview: buildPptPreview,
  captureSelectionAddress: capturePptSelectionLabel,
  subscribeSelectionChanged: subscribePptSelectionChanged,
};
