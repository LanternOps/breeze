// Edit-in-place for the persisted structured blocks (`table` / `callout`) —
// issue #3547. Before this, changing a shipped table meant delete-and-recreate,
// which is a real papercut on a large grid.
//
// Shape follows the contract block's precedent (QuoteContractBlockEditor):
// the block owns its own draft, saves through the parent's `onEditBlock`
// (→ updateBlock → PATCH /quotes/:id/blocks/:blockId), and flashes SrSaved on
// success. It differs in one deliberate way: contract blocks render their form
// unconditionally, but a table/callout's *rendered* form IS its content on the
// canvas (a table should look like a table), so editing is behind an explicit
// affordance and the read-only render stays the resting state.
//
// The fields themselves are the create-form's, imported from
// QuoteBlockContentForms and prefilled from the block's current content.
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { type QuoteBlock, type QuoteTableContent, type QuoteCalloutContent } from './quoteTypes';
import { SrSaved, useSavedFlash } from './quoteEditorShared';
import {
  TableBlockFields,
  CalloutBlockFields,
  tableFormFromContent,
  tableFormToContent,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  calloutFormFromContent,
  calloutFormToContent,
  type TableFormState,
  type CalloutFormState,
} from './QuoteBlockContentForms';

function EditToolbar({
  editing, busy, canSave = true, onEdit, onCancel, onSave, idBase, saved,
}: {
  editing: boolean;
  busy: boolean;
  /** Omitted where there is nothing to gate on (see TableBlockEditor). */
  canSave?: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  idBase: string;
  saved: boolean;
}) {
  const { t } = useTranslation('billing');
  return (
    <div className="mb-1 flex items-center gap-2">
      <SrSaved show={saved} testId={`${idBase}-saved`} />
      {editing ? (
        <>
          <button
            type="button"
            onClick={onSave}
            disabled={busy || !canSave}
            data-testid={`${idBase}-edit-save`}
            className="ml-auto inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {t('quotes.editor.block.saveEdit')}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            data-testid={`${idBase}-edit-cancel`}
            className="inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {t('quotes.editor.actions.cancel')}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          data-testid={`${idBase}-edit`}
          className="ml-auto inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          {t('quotes.editor.block.edit')}
        </button>
      )}
    </div>
  );
}

export function TableBlockEditor({
  block, canWrite, busy, onEditBlock,
}: {
  block: QuoteBlock;
  canWrite: boolean;
  busy: boolean;
  onEditBlock: (block: QuoteBlock, content: Record<string, unknown>) => Promise<boolean>;
}) {
  const { t } = useTranslation('billing');
  // `null` = not editing. Seeded from the block's content on open, so a
  // background refresh while the form is closed is always picked up, and one
  // mid-edit can never clobber the user's draft.
  const [form, setForm] = useState<TableFormState | null>(null);
  // Set when seeding had to reshape the stored content to fit the caps / the
  // exact-cells contract. Saving would then overwrite the block with the
  // reshaped version, so the user is told before they can do that.
  const [reshaped, setReshaped] = useState(false);
  const [saved, flash] = useSavedFlash();
  const content = block.content as Partial<QuoteTableContent> | undefined;
  const idBase = `quote-block-table-${block.id}`;

  const openEdit = useCallback(() => {
    const seed = tableFormFromContent(block.content);
    setForm(seed.form);
    setReshaped(seed.adjusted);
  }, [block.content]);
  const closeEdit = useCallback(() => { setForm(null); setReshaped(false); }, []);

  const save = useCallback(async () => {
    if (!form) return;
    if (await onEditBlock(block, tableFormToContent(form))) {
      closeEdit();
      flash();
    }
  }, [form, block, onEditBlock, flash, closeEdit]);

  const body = form ? (
    <>
      {reshaped && (
        <p
          className="mb-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning-foreground dark:text-warning"
          data-testid={`${idBase}-edit-reshaped`}
        >
          {t('quotes.editor.table.reshapedWarning', { columns: MAX_TABLE_COLUMNS, rows: MAX_TABLE_ROWS })}
        </p>
      )}
      <TableBlockFields
        value={form}
        onChange={setForm}
        idPrefix={`${idBase}-edit-form`}
        disabled={busy}
      />
    </>
  ) : !content?.columns?.length || !content?.rows?.length ? (
    <p className="text-sm text-muted-foreground" data-testid={`quote-block-table-content-${block.id}`}>
      {t('quotes.editor.block.tableEmpty')}
    </p>
  ) : (
    // Structured JSON, never HTML-parsed — column labels and cell values are
    // sanitized server-side with the inline-only profile on both write and read
    // (quoteService's read-path sanitizer), same dangerouslySetInnerHTML
    // precedent as QuoteDocument.tsx's canonical table rendering, which this
    // mirrors.
    <div className="overflow-x-auto" data-testid={`quote-block-table-content-${block.id}`}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className={content.headerStyle === 'plain' ? 'border-b-2' : 'border-b-2 bg-primary/10'}>
            {content.columns.map((col, i) => (
              <th
                key={i}
                style={{ textAlign: col.align ?? 'left' }}
                className="px-3 py-2 font-semibold text-foreground"
                dangerouslySetInnerHTML={{ __html: col.label }}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {content.rows.map((row, ri) => (
            <tr key={ri} className={content.zebra && ri % 2 === 1 ? 'bg-muted/30' : undefined}>
              {row.cells.map((cell, ci) => (
                <td
                  key={ci}
                  style={{ textAlign: content.columns?.[ci]?.align ?? 'left' }}
                  className="px-3 py-2 align-top text-foreground/90"
                  dangerouslySetInnerHTML={{ __html: cell }}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {content.caption && <p className="mt-1 text-xs text-muted-foreground">{content.caption}</p>}
    </div>
  );

  if (!canWrite) return body;
  return (
    <div>
      <EditToolbar
        editing={form !== null}
        busy={busy}
        // No validity gate, deliberately: the grid mutators keep the shape
        // schema-valid at all times and empty labels/cells are legal (the add
        // form submits a blank grid too), so there is nothing to gate on.
        onEdit={openEdit}
        onCancel={closeEdit}
        onSave={() => void save()}
        idBase={idBase}
        saved={saved}
      />
      {body}
    </div>
  );
}

export function CalloutBlockEditor({
  block, canWrite, busy, onEditBlock,
}: {
  block: QuoteBlock;
  canWrite: boolean;
  busy: boolean;
  onEditBlock: (block: QuoteBlock, content: Record<string, unknown>) => Promise<boolean>;
}) {
  const { t } = useTranslation('billing');
  const [form, setForm] = useState<CalloutFormState | null>(null);
  const [saved, flash] = useSavedFlash();
  const content = block.content as Partial<QuoteCalloutContent> | undefined;
  const idBase = `quote-block-callout-${block.id}`;

  const save = useCallback(async () => {
    if (!form || !form.html.trim()) return;
    if (await onEditBlock(block, calloutFormToContent(form))) {
      setForm(null);
      flash();
    }
  }, [form, block, onEditBlock, flash]);

  const tone =
    content?.variant === 'warn'
      ? 'border-amber-500/40 bg-amber-500/10'
      : content?.variant === 'accent'
        ? 'border-primary/40 bg-primary/10'
        : 'border-border bg-muted/40';

  const body = form ? (
    <CalloutBlockFields
      value={form}
      onChange={setForm}
      idPrefix={`${idBase}-edit-form`}
      disabled={busy}
    />
  ) : !content?.html?.trim() ? (
    <p className="text-sm text-muted-foreground" data-testid={`quote-block-callout-content-${block.id}`}>
      {t('quotes.editor.block.calloutEmpty')}
    </p>
  ) : (
    // Same server-sanitized-HTML precedent as rich_text.
    <div className={`rounded-lg border-l-4 p-4 ${tone}`} data-testid={`quote-block-callout-content-${block.id}`}>
      {content.title && <p className="mb-1 text-sm font-semibold text-foreground">{content.title}</p>}
      <div
        className="quote-rich-text prose prose-sm max-w-prose dark:prose-invert"
        dangerouslySetInnerHTML={{ __html: content.html }}
      />
    </div>
  );

  if (!canWrite) return body;
  return (
    <div>
      <EditToolbar
        editing={form !== null}
        busy={busy}
        // An empty body is not a valid callout (quoteCalloutContentSchema aside,
        // it renders as nothing) — same gate the add form applies to submit.
        canSave={form !== null && form.html.trim() !== ''}
        onEdit={() => setForm(calloutFormFromContent(block.content))}
        onCancel={() => setForm(null)}
        onSave={() => void save()}
        idBase={idBase}
        saved={saved}
      />
      {body}
    </div>
  );
}
