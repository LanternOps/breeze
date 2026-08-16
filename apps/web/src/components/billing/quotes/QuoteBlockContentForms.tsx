// The authoring fields for the structured `table` and `callout` blocks, shared
// by BOTH the add-block form (QuoteEditor) and the edit-in-place affordance on
// a persisted block (QuoteBlockCard) — issue #3547. Extracted rather than
// duplicated so the two surfaces can never drift: one grid invariant, one set
// of caps, one set of test ids.
//
// Each surface owns a single form-state object and passes it down; the mutators
// are pure functions over that state, so the "every row has exactly
// columns.length cells" invariant quoteTableContentSchema enforces server-side
// is maintained at every mutation, on both surfaces.
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import type { QuoteTableColumn, QuoteTableContent, QuoteCalloutContent } from '@breeze/shared';
import RichTextEditor from '../../common/RichTextEditor';
import InlineRichTextEditor from '../../common/InlineRichTextEditor';

// Caps mirrored from quoteTableContentSchema (8 cols x 100 rows x 2000 chars).
export const MAX_TABLE_COLUMNS = 8;
export const MAX_TABLE_ROWS = 100;

// ── table ───────────────────────────────────────────────────────────────────

export type TableFormState = {
  columns: QuoteTableColumn[];
  rows: { cells: string[] }[];
  caption: string;
  zebra: boolean;
  headerStyle: 'accent' | 'plain';
};

export function freshTableForm(): TableFormState {
  return {
    columns: [{ label: '' }, { label: '' }],
    rows: [{ cells: ['', ''] }, { cells: ['', ''] }],
    caption: '',
    zebra: false,
    headerStyle: 'plain',
  };
}

/** Seed the form from a persisted block's content. Defensive about shape: a
 *  legacy or hand-written row that disagrees with columns.length is padded or
 *  trimmed HERE (once, visibly, before the user edits) rather than being sent
 *  back to the API where the schema's exact-shape refinement would reject it. */
export function tableFormFromContent(content: unknown): TableFormState {
  const c = (content ?? {}) as Partial<QuoteTableContent>;
  const columns = Array.isArray(c.columns) && c.columns.length > 0
    ? c.columns.slice(0, MAX_TABLE_COLUMNS).map((col) => ({ ...col }))
    : [{ label: '' }];
  const rawRows = Array.isArray(c.rows) && c.rows.length > 0 ? c.rows.slice(0, MAX_TABLE_ROWS) : [{ cells: [] }];
  const rows = rawRows.map((r) => {
    const cells = Array.isArray(r?.cells) ? r.cells.slice(0, columns.length) : [];
    while (cells.length < columns.length) cells.push('');
    return { cells };
  });
  return {
    columns,
    rows,
    caption: c.caption ?? '',
    zebra: c.zebra ?? false,
    headerStyle: c.headerStyle ?? 'plain',
  };
}

/** The PATCH/POST body content for a table block. Mirrors the add-block
 *  builder exactly: an empty caption is omitted rather than sent as ''. */
export function tableFormToContent(form: TableFormState): Record<string, unknown> {
  return {
    columns: form.columns,
    rows: form.rows.map((r) => ({ cells: r.cells })),
    ...(form.caption.trim() ? { caption: form.caption.trim() } : {}),
    zebra: form.zebra,
    headerStyle: form.headerStyle,
  };
}

export const tableForm = {
  addColumn: (f: TableFormState): TableFormState =>
    f.columns.length >= MAX_TABLE_COLUMNS
      ? f
      : { ...f, columns: [...f.columns, { label: '' }], rows: f.rows.map((r) => ({ cells: [...r.cells, ''] })) },
  removeColumn: (f: TableFormState, idx: number): TableFormState =>
    f.columns.length <= 1
      ? f
      : {
          ...f,
          columns: f.columns.filter((_, i) => i !== idx),
          rows: f.rows.map((r) => ({ cells: r.cells.filter((_, i) => i !== idx) })),
        },
  addRow: (f: TableFormState): TableFormState =>
    f.rows.length >= MAX_TABLE_ROWS ? f : { ...f, rows: [...f.rows, { cells: Array(f.columns.length).fill('') }] },
  removeRow: (f: TableFormState, idx: number): TableFormState =>
    f.rows.length <= 1 ? f : { ...f, rows: f.rows.filter((_, i) => i !== idx) },
  setColumnLabel: (f: TableFormState, idx: number, label: string): TableFormState =>
    ({ ...f, columns: f.columns.map((c, i) => (i === idx ? { ...c, label } : c)) }),
  setColumnAlign: (f: TableFormState, idx: number, align: QuoteTableColumn['align']): TableFormState =>
    ({ ...f, columns: f.columns.map((c, i) => (i === idx ? { ...c, align } : c)) }),
  setCell: (f: TableFormState, rowIdx: number, colIdx: number, html: string): TableFormState =>
    ({ ...f, rows: f.rows.map((r, i) => (i === rowIdx ? { cells: r.cells.map((c, j) => (j === colIdx ? html : c)) } : r)) }),
};

export function TableBlockFields({
  value, onChange, idPrefix = 'quote-block-table', disabled = false,
}: {
  value: TableFormState;
  onChange: (next: TableFormState) => void;
  /** Test-id / DOM-id namespace. Defaults to the add-form's ids; the
   *  edit-in-place surface passes a per-block prefix so several forms can be
   *  mounted at once without colliding. */
  idPrefix?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation('billing');
  return (
    <div className="mb-3 space-y-3" data-testid={idPrefix}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] border-separate border-spacing-1 text-xs">
          <thead>
            <tr>
              {value.columns.map((col, colIdx) => (
                <th key={colIdx} className="text-left font-normal">
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={col.label}
                      maxLength={200}
                      disabled={disabled}
                      onChange={(e) => onChange(tableForm.setColumnLabel(value, colIdx, e.target.value))}
                      placeholder={t('quotes.editor.table.columnLabelPlaceholder')}
                      data-testid={`${idPrefix}-column-label-${colIdx}`}
                      className="h-8 w-full rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
                    />
                    <select
                      value={col.align ?? 'left'}
                      disabled={disabled}
                      onChange={(e) => onChange(tableForm.setColumnAlign(value, colIdx, e.target.value as QuoteTableColumn['align']))}
                      aria-label={t('quotes.editor.table.columnAlignAria')}
                      data-testid={`${idPrefix}-column-align-${colIdx}`}
                      className="h-8 rounded-md border bg-background px-1 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
                    >
                      <option value="left">{t('quotes.editor.table.alignLeft')}</option>
                      <option value="center">{t('quotes.editor.table.alignCenter')}</option>
                      <option value="right">{t('quotes.editor.table.alignRight')}</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => onChange(tableForm.removeColumn(value, colIdx))}
                      disabled={disabled || value.columns.length <= 1}
                      aria-label={t('quotes.editor.table.removeColumn')}
                      title={t('quotes.editor.table.removeColumn')}
                      data-testid={`${idPrefix}-remove-column-${colIdx}`}
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-40"
                    >
                      &times;
                    </button>
                  </div>
                </th>
              ))}
              <th className="w-8">
                <button
                  type="button"
                  onClick={() => onChange(tableForm.addColumn(value))}
                  disabled={disabled || value.columns.length >= MAX_TABLE_COLUMNS}
                  aria-label={t('quotes.editor.table.addColumn')}
                  title={t('quotes.editor.table.addColumn')}
                  data-testid={`${idPrefix}-add-column`}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted disabled:opacity-40"
                >
                  +
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {value.rows.map((row, rowIdx) => (
              <tr key={rowIdx}>
                {row.cells.map((cell, colIdx) => (
                  <td key={colIdx} className="align-top">
                    <InlineRichTextEditor
                      value={cell}
                      onChange={(html) => onChange(tableForm.setCell(value, rowIdx, colIdx, html))}
                      ariaLabel={t('quotes.editor.table.cellAria', { row: rowIdx + 1, column: colIdx + 1 })}
                      testId={`${idPrefix}-cell-${rowIdx}-${colIdx}`}
                      maxLength={2000}
                    />
                  </td>
                ))}
                <td className="align-top">
                  <button
                    type="button"
                    onClick={() => onChange(tableForm.removeRow(value, rowIdx))}
                    disabled={disabled || value.rows.length <= 1}
                    aria-label={t('quotes.editor.table.removeRow')}
                    title={t('quotes.editor.table.removeRow')}
                    data-testid={`${idPrefix}-remove-row-${rowIdx}`}
                    className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-40"
                  >
                    &times;
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={() => onChange(tableForm.addRow(value))}
        disabled={disabled || value.rows.length >= MAX_TABLE_ROWS}
        data-testid={`${idPrefix}-add-row`}
        className="inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-40"
      >
        {t('quotes.editor.table.addRow')}
      </button>
      <input
        type="text"
        value={value.caption}
        maxLength={300}
        disabled={disabled}
        onChange={(e) => onChange({ ...value, caption: e.target.value })}
        placeholder={t('quotes.editor.table.captionPlaceholder')}
        data-testid={`${idPrefix}-caption`}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
      />
      <div className="flex flex-wrap items-center gap-4">
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={value.zebra}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, zebra: e.target.checked })}
            data-testid={`${idPrefix}-zebra`}
          />
          {t('quotes.editor.table.zebra')}
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          {t('quotes.editor.table.headerStyle')}
          <select
            value={value.headerStyle}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, headerStyle: e.target.value as 'accent' | 'plain' })}
            data-testid={`${idPrefix}-header-style`}
            className="h-8 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
          >
            <option value="plain">{t('quotes.editor.table.headerStylePlain')}</option>
            <option value="accent">{t('quotes.editor.table.headerStyleAccent')}</option>
          </select>
        </label>
      </div>
    </div>
  );
}

// ── callout ─────────────────────────────────────────────────────────────────

export type CalloutFormState = {
  variant: QuoteCalloutContent['variant'];
  title: string;
  html: string;
};

export function freshCalloutForm(): CalloutFormState {
  return { variant: 'info', title: '', html: '' };
}

export function calloutFormFromContent(content: unknown): CalloutFormState {
  const c = (content ?? {}) as Partial<QuoteCalloutContent>;
  return { variant: c.variant ?? 'info', title: c.title ?? '', html: c.html ?? '' };
}

export function calloutFormToContent(form: CalloutFormState): Record<string, unknown> {
  return {
    variant: form.variant,
    ...(form.title.trim() ? { title: form.title.trim() } : {}),
    html: form.html,
  };
}

export function CalloutBlockFields({
  value, onChange, idPrefix = 'quote-block-callout', disabled = false,
}: {
  value: CalloutFormState;
  onChange: (next: CalloutFormState) => void;
  idPrefix?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation('billing');
  return (
    <div className="mb-3 space-y-3" data-testid={idPrefix}>
      <div>
        <label htmlFor={`${idPrefix}-variant`} className="mb-1 block text-xs text-muted-foreground">
          {t('quotes.editor.callout.variantLabel')}
        </label>
        <select
          id={`${idPrefix}-variant`}
          value={value.variant}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, variant: e.target.value as QuoteCalloutContent['variant'] })}
          data-testid={`${idPrefix}-variant`}
          className="h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
        >
          <option value="info">{t('quotes.editor.callout.variantInfo')}</option>
          <option value="accent">{t('quotes.editor.callout.variantAccent')}</option>
          <option value="warn">{t('quotes.editor.callout.variantWarn')}</option>
        </select>
      </div>
      <input
        type="text"
        value={value.title}
        maxLength={200}
        disabled={disabled}
        onChange={(e) => onChange({ ...value, title: e.target.value })}
        placeholder={t('quotes.editor.callout.titlePlaceholder')}
        data-testid={`${idPrefix}-title`}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60"
      />
      <RichTextEditor
        value={value.html}
        onChange={(html) => onChange({ ...value, html })}
        ariaLabel={t('quotes.editor.callout.bodyAria')}
        testId={`${idPrefix}-body`}
      />
    </div>
  );
}
