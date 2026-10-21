import { Fragment, type ReactElement } from 'react';
import type { DocumentLineRow, DocumentLineTableModel, DocumentMoney as DocumentMoneyValue } from '@breeze/shared/documents';
import { DocumentLineDescription } from './DocumentLineDescription';
import { DocumentMoney } from './DocumentMoney';
import type { DocumentHostComponents } from './hostComponents';

type Cell = DocumentMoneyValue | 'exempt' | null;
type AnyRow = DocumentLineRow<Cell>;

const NUM = 'hidden whitespace-nowrap px-2 py-3 text-right tabular-nums text-muted-foreground sm:table-cell';

function Row({ row, showTax, notTaxable, components }: { row: AnyRow; showTax: boolean; notTaxable: string; components: DocumentHostComponents }): ReactElement {
  const description = (
        <DocumentLineDescription
          rowKey={row.key}
          title={row.title}
          blurb={row.blurb}
          workDate={row.workDate}
          note={row.note}
          descriptor={row.descriptor}
          ticketText={row.ticketText}
          qtyFold={`${row.qty} × ${row.unit.text}`}
        />
  );
  return (
    <tr className="border-b align-top last:border-0" data-testid={`document-line-${row.key}`}>
      {/* V-6: an unbroken token (a URL, a part number) wraps instead of pushing the
          Amount column out of the paper at phone width. */}
      <td className={`w-full min-w-0 px-4 py-3 [overflow-wrap:anywhere] sm:px-5 ${row.isChild ? 'pl-8 text-muted-foreground' : 'text-foreground'}`}>
        {row.isChild && <span aria-hidden>↳ </span>}
        {row.thumbnail ? (
          // A quote line's product image sits beside the description; a host Image that
          // cannot fetch it renders nothing, so image-less lines get no empty box.
          <div className="flex items-start gap-2.5">
            <components.Image asset={row.thumbnail} alt="" className="h-10 w-10 shrink-0 rounded border bg-card object-contain" />
            <div className="min-w-0">{description}</div>
          </div>
        ) : description}
      </td>
      <td className={NUM}>{row.qty}</td>
      <td className={NUM}><DocumentMoney value={row.unit} /></td>
      {showTax && (
        <td className={NUM}>
          {row.tax === 'exempt' || row.tax === null
            ? <><span aria-hidden>—</span><span className="sr-only">{notTaxable}</span></>
            : <DocumentMoney value={row.tax} />}
        </td>
      )}
      <td className="whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums text-foreground sm:px-5">
        <DocumentMoney value={row.amount} />
      </td>
    </tr>
  );
}

export function DocumentLineTable({ table, components }: { table: DocumentLineTableModel; components: DocumentHostComponents }): ReactElement {
  if (table.emptyText) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 px-6 py-12 text-center text-sm text-muted-foreground">
        {table.emptyText}
      </div>
    );
  }
  const showTax = table.columns.tax !== null;
  const notTaxable = 'notTaxable' in table.columns ? table.columns.notTaxable : '';
  const span = showTax ? 5 : 4;
  const groups = table.groups as { key: string; header: DocumentLineTableModel['groups'][number]['header']; days: { key: string; header: { date: { text: string; iso: string }; hours: string; total: DocumentMoneyValue } | null; rows: AnyRow[] }[] }[];
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {table.label && (
        <div className="border-b bg-muted/40 px-4 py-2.5 text-sm font-semibold text-foreground sm:px-5">{table.label}</div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 text-left font-medium sm:px-5">{table.columns.description}</th>
              <th className="hidden px-2 py-2.5 text-right font-medium sm:table-cell">{table.columns.qty}</th>
              <th className="hidden px-2 py-2.5 text-right font-medium sm:table-cell">{table.columns.unitPrice}</th>
              {showTax && <th className="hidden px-2 py-2.5 text-right font-medium sm:table-cell">{table.columns.tax}</th>}
              <th className="whitespace-nowrap px-4 py-2.5 text-right font-medium sm:px-5">{table.columns.amount}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.key}>
                {group.header?.kind === 'ticket' && (
                  <tr className="border-b bg-muted/30">
                    <td colSpan={span} className="px-4 py-2 sm:px-5">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold text-foreground">{group.header.title}</span>
                        {group.header.category && (
                          <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{group.header.category}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
                {group.header?.kind === 'cadence' && (
                  <tr className="border-b bg-muted/30">
                    <td colSpan={span} className="px-4 py-2 text-xs font-semibold text-foreground sm:px-5">{group.header.label}</td>
                  </tr>
                )}
                {group.days.map((day) => (
                  <Fragment key={day.key}>
                    {day.header && (
                      <tr className="border-b" data-testid={`document-day-${day.header.date.iso}`}>
                        <td className="px-4 py-2 text-xs font-semibold text-muted-foreground sm:px-5">
                          <time dateTime={day.header.date.iso}>{day.header.date.text}</time>
                        </td>
                        <td className="hidden whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted-foreground sm:table-cell">{day.header.hours}</td>
                        <td className="hidden px-2 py-2 sm:table-cell" />
                        {showTax && <td className="hidden px-2 py-2 sm:table-cell" />}
                        <td className="whitespace-nowrap px-4 py-2 text-right text-xs font-semibold tabular-nums text-foreground sm:px-5">
                          <DocumentMoney value={day.header.total} />
                        </td>
                      </tr>
                    )}
                    {day.rows.map((row) => <Row key={row.key} row={row} showTax={showTax} notTaxable={notTaxable} components={components} />)}
                  </Fragment>
                ))}
              </Fragment>
            ))}
          </tbody>
          {table.subtotal && (
            <tfoot>
              <tr className="border-t-2 bg-muted/20" data-testid="document-table-subtotal">
                <td className="px-4 py-2.5 text-right text-sm font-semibold text-foreground sm:px-5" colSpan={span - 1}>{table.subtotal.label}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right text-sm font-semibold tabular-nums text-foreground sm:px-5">
                  {table.subtotal.parts.map((part, i) => (
                    <Fragment key={i}>{i > 0 && ' + '}<DocumentMoney value={part} /></Fragment>
                  ))}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
