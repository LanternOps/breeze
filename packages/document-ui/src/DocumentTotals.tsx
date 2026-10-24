import { Fragment, type ReactElement } from 'react';
import type { DocumentMoney as DocumentMoneyValue, DocumentTotalsModel } from '@breeze/shared/documents';
import { DocumentMoney } from './DocumentMoney';

function Values({ value }: { value: DocumentMoneyValue | DocumentMoneyValue[] }): ReactElement {
  const list = Array.isArray(value) ? value : [value];
  return (
    <>
      {list.map((v, i) => (
        <Fragment key={i}>{i > 0 && ' + '}<DocumentMoney value={v} /></Fragment>
      ))}
    </>
  );
}

export function DocumentTotals({ totals }: { totals: DocumentTotalsModel }): ReactElement {
  return (
    <section className="flex justify-end">
      <div className="w-full max-w-xs space-y-2.5">
        {totals.rows.map((row) => {
          if (row.weight === 'hero') {
            return (
              <div key={row.key} data-testid="document-totals-hero" className={`${row.ruleAbove === 'accent' ? 'doc-accent-border ' : ''}flex items-baseline justify-between gap-3${row.ruleAbove === 'accent' ? ' border-t pt-3' : ''}`}>
                <span className="text-sm font-semibold text-foreground">{row.label}</span>
                {/* V-26: the hero balance speaks the serif (DESIGN.md), on every surface. */}
                <span className="doc-accent-text doc-font-display text-2xl font-semibold tabular-nums"><Values value={row.value} /></span>
              </div>
            );
          }
          const strong = row.weight === 'strong';
          return (
            <div key={row.key} className={`flex justify-between text-sm ${row.ruleAbove === 'neutral' ? 'border-t pt-2.5' : row.ruleAbove === 'accent' ? 'doc-accent-border border-t pt-3' : ''}`}>
              <span className={strong ? 'font-medium text-foreground' : 'text-muted-foreground'}>{row.label}</span>
              <span className={`tabular-nums text-foreground ${strong ? 'font-medium' : ''}`}>
                {row.sign === 'minus' && '−'}
                <Values value={row.value} />
              </span>
            </div>
          );
        })}
        {totals.aside && (
          <div className="space-y-1.5 rounded-lg bg-muted/40 p-3 text-sm" data-testid="document-totals-aside">
            {totals.aside.rows.map((row) => (
              <div key={row.key} className="flex justify-between">
                <span className="text-muted-foreground">{row.label}</span>
                <span className="tabular-nums text-foreground"><Values value={row.value} /></span>
              </div>
            ))}
            <p className="pt-1 text-xs leading-relaxed text-muted-foreground">{totals.aside.note}</p>
          </div>
        )}
        {totals.depositStrip && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground" data-testid="document-deposit">
            {totals.depositStrip.parts.map((part, i) =>
              typeof part === 'string'
                ? <span key={i}>{part}</span>
                : <strong key={i} className="text-foreground">{part.strong}</strong>,
            )}
          </div>
        )}
      </div>
    </section>
  );
}
