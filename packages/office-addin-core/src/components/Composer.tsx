import { useSelectionAddress } from '../hooks/useSelectionAddress';
import { parseAddress, stripSheet } from '../lib/address';
import type { WorkbookContextKind } from '../api/types';

// Excel-flavored defaults. Hosts that don't fit the workbook vocabulary
// (Outlook: mail) override these via the optional `contextOptions` /
// `composerPlaceholder` props below; Excel/Word/PowerPoint inherit them.
const DEFAULT_CONTEXT_OPTIONS: Array<{ value: WorkbookContextKind; label: string }> = [
  { value: 'selection', label: 'Selection' },
  { value: 'sheet', label: 'Whole sheet' },
  { value: 'none', label: 'No workbook data' },
];
const DEFAULT_COMPOSER_PLACEHOLDER = 'Ask about this workbook…';

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
}) {
  const selection = useSelectionAddress({
    captureSelectionAddress,
    subscribeSelectionChanged,
  });
  const sheetName = selection ? parseAddress(selection).sheet : null;
  const chip =
    contextKind === 'none'
      ? 'No workbook data'
      : contextKind === 'sheet'
        ? sheetName
          ? `Sheet: ${sheetName}`
          : 'Whole sheet'
        : selection
          ? `Selection ${stripSheet(selection)}`
          : 'Selection';
  return (
    <div className="border-t border-gray-200 p-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700" data-testid="context-chip">
          {chip}
        </span>
        <select
          className="ml-auto rounded border border-gray-200 text-xs"
          value={contextKind}
          onChange={(e) => onContextKindChange(e.target.value as WorkbookContextKind)}
          data-testid="context-select"
        >
          {contextOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
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
