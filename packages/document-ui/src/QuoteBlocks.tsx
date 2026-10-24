import type { ReactElement } from 'react';
import type { QuoteBlockModel, QuoteTableBlock } from '@breeze/shared/documents';
import { DocumentLineTable } from './DocumentLineTable';
import type { DocumentHostComponents } from './hostComponents';

/** Author-chosen column alignment as a class (never an inline `textAlign`: CSP). */
const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' } as const;

const HEADING = {
  1: 'text-2xl font-bold',
  2: 'text-xl font-semibold',
  3: 'text-lg font-semibold',
} as const;

const CALLOUT = {
  warn: 'border-warning/40 bg-warning/10',
  accent: 'border-primary/40 bg-primary/10',
  neutral: 'border-border bg-muted/40',
} as const;

// Table cells and column labels are HTML the server's inline-only sanitizer already
// cleaned; the model types them `SanitizedHtml`, the only type these sinks accept.
function TableBlock({ table, testId }: { table: QuoteTableBlock; testId: string }): ReactElement {
  return (
    <div className="overflow-x-auto" data-testid={testId}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className={table.headerStyle === 'plain' ? 'border-b-2' : 'border-b-2 bg-primary/10'}>
            {table.columns.map((col, i) => (
              <th
                key={i}
                scope="col"
                className={`px-3 py-2 font-semibold text-foreground ${ALIGN[col.align]}`}
                dangerouslySetInnerHTML={{ __html: col.label }}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={row.key} className={table.zebra && ri % 2 === 1 ? 'bg-muted/30' : undefined}>
              {row.cells.map((cell, ci) => (
                <td
                  key={ci}
                  className={`px-3 py-2 align-top text-foreground/90 ${ALIGN[table.columns[ci]!.align]}`}
                  dangerouslySetInnerHTML={{ __html: cell }}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.caption && <p className="mt-1 text-xs text-muted-foreground">{table.caption}</p>}
    </div>
  );
}

function Block({ block, components }: { block: QuoteBlockModel; components: DocumentHostComponents }): ReactElement {
  const testId = `document-block-${block.key}`;
  switch (block.kind) {
    case 'heading':
      return <h2 className={HEADING[block.level]} data-testid={testId}>{block.text}</h2>;
    case 'rich_text':
      return (
        <div
          className="quote-rich-text text-sm leading-relaxed text-foreground"
          data-testid={testId}
          dangerouslySetInnerHTML={{ __html: block.html }}
        />
      );
    case 'table':
      return <TableBlock table={block.table} testId={testId} />;
    case 'callout':
      return (
        <div className={`rounded-lg border p-4 ${CALLOUT[block.tone]}`} data-testid={testId}>
          {block.title && <p className="mb-1 text-sm font-semibold text-foreground">{block.title}</p>}
          <div className="quote-rich-text text-sm leading-relaxed text-foreground" dangerouslySetInnerHTML={{ __html: block.html }} />
        </div>
      );
    case 'image':
      return (
        <figure data-testid={testId}>
          {block.image ? (
            <components.Image
              asset={block.image}
              alt={block.alt}
              width={block.width ?? undefined}
              unavailableText={block.unavailableText}
              // The author's width rides on the `width` ATTRIBUTE (presentational, so it survives
              // `style-src-attr 'none'`); max-w-full keeps it inside a narrow phone.
              className="h-auto max-w-full rounded-lg border"
            />
          ) : (
            <div className="rounded-lg border bg-muted/50 p-4 text-sm text-muted-foreground">{block.unavailableText}</div>
          )}
          {block.caption && <figcaption className="mt-2 text-xs text-muted-foreground">{block.caption}</figcaption>}
        </figure>
      );
    case 'line_items':
      return (
        <div data-testid={testId}>
          <DocumentLineTable table={block.table} components={components} />
        </div>
      );
  }
}

/** The proposal body: the author's blocks in order, then the default pricing table
 *  for lines no block claimed (already appended by the builder). */
export function QuoteBlocks({ blocks, components }: { blocks: QuoteBlockModel[]; components: DocumentHostComponents }): ReactElement {
  return (
    <div className="space-y-6">
      {blocks.map((block) => <Block key={block.key} block={block} components={components} />)}
    </div>
  );
}
