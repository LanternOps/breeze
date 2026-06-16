/**
 * The PowerPoint tool layer, keyed by wire tool name (byte-identical to the
 * server registry keys). Reads auto-execute; the three mutating tools are
 * approval-gated by the core via POWERPOINT_MUTATING_TOOLS.
 */
import type { ToolExecutor } from '@breeze/office-addin-core';
import { getPresentationOverview } from './getPresentationOverview';
import { readSelection } from './readSelection';
import { addSlide } from './addSlide';
import { insertTextBox } from './insertTextBox';
import { formatSelection } from './formatSelection';

export const POWERPOINT_TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  get_presentation_overview: getPresentationOverview,
  read_selection: readSelection,
  add_slide: addSlide,
  insert_text_box: insertTextBox,
  format_selection: formatSelection,
};

export const POWERPOINT_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'add_slide',
  'insert_text_box',
  'format_selection',
]);
