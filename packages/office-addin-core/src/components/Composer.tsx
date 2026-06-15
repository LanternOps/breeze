import { useSelectionAddress } from '../hooks/useSelectionAddress';
import { parseAddress, stripSheet } from '../lib/address';
import type { WorkbookContextKind } from '../api/types';

// Excel-flavored defaults. Hosts that don't fit the workbook vocabulary
// (Outlook: mail) override these via the optional `contextOptions` /
// `composerPlaceholder` props below; Excel/Word/PowerPoint inherit them.
const DEFAULT_CONTEXT_OPTIONS: Array<{ value: WorkbookContextKind; label: string }> = [
  { value: 'selection', label: 'Selection' },
  { value: 'sheet', label: 'Whole sheet' },
  { value: 'none', label: '(none)' },
];
const DEFAULT_COMPOSER_PLACEHOLDER = 'Ask anything about this workbook…';

// Tooltip on the context picker (and chip) — explains what the control does.
// Host-neutral wording ("this file") since the picker only shows on the
// document hosts (Excel/Word/PowerPoint); Outlook hides it.
const CONTEXT_PICKER_HINT =
  'Choose how much of this file the assistant can see for your next message: your current selection, the whole file, or nothing (a general question).';

// Excel-flavored chip: the selection label is a sheet-qualified range, so we
// strip the sheet for the selection chip (`Selection B2`) and surface the sheet
// name for the whole-sheet kind (`Sheet: Budget`). Hosts whose selection label
// isn't an Excel address (Word snippet, Outlook subject) override this via the
// adapter's `formatContextChip` so the address parser never runs on their text.
function excelContextChip(kind: WorkbookContextKind, selection: string | undefined): string {
  // parseAddress THROWS on anything that isn't an A1 range. A host that wrongly
  // inherits this default (its selection label isn't an address) would otherwise
  // crash the whole pane to blank on the first selection change — so never let a
  // bad label propagate; degrade to no sheet name.
  let sheetName: string | null = null;
  if (selection) {
    try {
      sheetName = parseAddress(selection).sheet;
    } catch {
      sheetName = null;
    }
  }
  return kind === 'none'
    ? '(none)'
    : kind === 'sheet'
      ? sheetName
        ? `Sheet: ${sheetName}`
        : 'Whole sheet'
      : selection
        ? `Selection ${stripSheet(selection)}`
        : 'Selection';
}

export function Composer({
  draft,
  busy,
  contextKind,
  captureSelectionAddress,
  subscribeSelectionChanged,
  onDraftChange,
  onContextKindChange,
  onSend,
  contextOptions = DEFAULT_CONTEXT_OPTIONS,
  composerPlaceholder = DEFAULT_COMPOSER_PLACEHOLDER,
  formatContextChip,
  hideContextPicker = false,
}: {
  draft: string;
  busy: boolean;
  contextKind: WorkbookContextKind;
  // Selection fns are threaded from ChatPane (the Excel adapter today) so the
  // composer stays host-neutral and never imports `Excel.*` or the concrete host.
  captureSelectionAddress: () => Promise<string | undefined>;
  subscribeSelectionChanged: (cb: () => void) => () => void;
  onDraftChange: (text: string) => void;
  onContextKindChange: (kind: WorkbookContextKind) => void;
  onSend: () => void;
  // OPTIONAL host vocabulary (Outlook supplies mail-flavored strings); when
  // omitted the Excel defaults above are used so Excel/Word/PPT are untouched.
  contextOptions?: Array<{ value: WorkbookContextKind; label: string }>;
  composerPlaceholder?: string;
  // OPTIONAL host-specific chip formatter (Word/Outlook supply one); when omitted
  // the Excel address-aware default is used so Excel is untouched.
  formatContextChip?: (kind: WorkbookContextKind, selectionLabel: string | undefined) => string;
  // OPTIONAL: hide the context-source dropdown (Outlook); the chip still shows.
  hideContextPicker?: boolean;
}) {
  const selection = useSelectionAddress({
    captureSelectionAddress,
    subscribeSelectionChanged,
  });
  const chip = (formatContextChip ?? excelContextChip)(contextKind, selection ?? undefined);
  return (
    <div className="border-t border-gray-200 p-2">
      <div className="mb-1 flex items-center gap-2">
        <span
          className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700"
          data-testid="context-chip"
          title={CONTEXT_PICKER_HINT}
        >
          {chip}
        </span>
        {!hideContextPicker && (
          <select
            className="ml-auto rounded border border-gray-200 text-xs"
            value={contextKind}
            onChange={(e) => onContextKindChange(e.target.value as WorkbookContextKind)}
            data-testid="context-select"
            title={CONTEXT_PICKER_HINT}
            aria-label={CONTEXT_PICKER_HINT}
          >
            {contextOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={2}
          placeholder={composerPlaceholder}
          className="flex-1 resize-none rounded border border-gray-300 p-2 text-sm"
          data-testid="composer-input"
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          className="self-end rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50"
          data-testid="composer-send"
        >
          Send
        </button>
      </form>
    </div>
  );
}
