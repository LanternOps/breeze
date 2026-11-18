import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import type { QuoteGeneratedContract } from './quoteTypes';

/**
 * #10361: the contracts an accepted quote created. The recurring half of an
 * accept lands as DRAFT contracts that bill nothing until someone activates
 * them; before this, nothing on the quote said they existed. Renders nothing
 * when there are none, or when the server withheld the list (`null`: the viewer
 * lacks contracts:read).
 */
export default function QuoteGeneratedContracts({ contracts, unavailable }: {
  contracts: QuoteGeneratedContract[] | null | undefined;
  /** The server tried and failed to read them — say so, rather than render a
   *  silence that reads as "this quote created no contract". */
  unavailable?: boolean;
}) {
  const { t } = useTranslation('billing');
  if (unavailable) {
    return (
      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground" data-testid="quote-generated-contracts-unavailable">
        {t('quotes.detail.generatedContracts.unavailable')}
      </p>
    );
  }
  if (!contracts || contracts.length === 0) return null;
  const drafts = contracts.filter((c) => c.status === 'draft').length;

  return (
    <aside className="rounded-lg border border-primary/25 bg-primary/5 p-4" data-testid="quote-generated-contracts">
      <p className="text-sm font-medium text-foreground">
        {t('quotes.detail.generatedContracts.title', { count: contracts.length })}
      </p>
      {drafts > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('quotes.detail.generatedContracts.draftHint', { count: drafts })}
        </p>
      )}
      <ul className="mt-2 space-y-1.5">
        {contracts.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-testid={`quote-generated-contract-${c.id}`}>
            <a
              href={`/contracts/${c.id}`}
              data-testid={`quote-generated-contract-link-${c.id}`}
              className="min-w-0 break-words rounded-xs font-medium text-primary hover:underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {c.name}
            </a>
            {c.status === 'draft' ? (
              <span
                className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
                data-testid={`quote-generated-contract-ready-${c.id}`}
              >
                {t('quotes.detail.generatedContracts.ready')}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                {t(/* i18n-dynamic */ `contracts.shared.status.${c.status}`)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
