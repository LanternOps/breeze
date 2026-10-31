import { FileSignature } from 'lucide-react';
import { signedAgreementFilePath, type PortalAgreementSummary, type PortalSignedAgreement } from '@/lib/api';
import { withBase } from '@/lib/basePath';
import { shortDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorNotice, LINK, PageHeader } from './ui';

interface AgreementListProps {
  pending: PortalAgreementSummary[];
  signed: PortalSignedAgreement[];
  error?: string | null;
  /** The org zone from the API; this list is SSR-only, so without it dates print in the server's zone (#10291). */
  timezone: string;
}

function sourceLine(a: PortalSignedAgreement): string {
  if (a.sourceKind === 'quote') {
    return a.quoteNumber ? `Accepted with proposal ${a.quoteNumber}` : 'Accepted with a proposal';
  }
  return 'Signed agreement';
}

const LIST = 'divide-y divide-border/70 border-y border-border/70';
const ITEM = 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 py-3.5 sm:px-4';
const SECTION_HEADING = 'mb-2 font-display text-lg font-semibold text-foreground';

export function AgreementList({ pending, signed, error, timezone }: AgreementListProps) {
  if (error) {
    return (
      <div data-testid="agreements-load-error">
        <ErrorNotice>{error}</ErrorNotice>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <PageHeader
        title="Agreements"
        lede="Agreements your IT team has sent for signature, and the signed copies on file."
      />

      <section aria-labelledby="agreements-pending-heading">
        <h2 id="agreements-pending-heading" className={SECTION_HEADING}>Awaiting signature</h2>
        {pending.length === 0 ? (
          <EmptyState
            data-testid="agreements-pending-empty"
            icon={<FileSignature className="h-10 w-10" strokeWidth={1.5} />}
            title="Nothing awaiting signature"
          >
            <p className="mt-1 text-sm text-muted-foreground">
              When your IT team sends an agreement for signature, it appears here.
            </p>
          </EmptyState>
        ) : (
          <ul className={LIST} data-testid="agreements-pending-list">
            {pending.map((a) => (
              <li key={a.id} data-testid={`agreements-pending-row-${a.id}`} className={ITEM}>
                <div>
                  <p className="font-semibold text-foreground">{a.name}</p>
                  <p className="text-figures text-xs text-muted-foreground sm:text-sm">
                    Expires {shortDate(a.expiresAt, timezone)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {!a.canSign && (
                    <span className="text-xs text-muted-foreground">Sent to another contact</span>
                  )}
                  <a className={LINK} href={withBase(`/agreements/${a.id}`)}>
                    {a.canSign ? 'Review & sign' : 'View'}
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="agreements-signed-heading">
        <h2 id="agreements-signed-heading" className={SECTION_HEADING}>Signed agreements</h2>
        {signed.length === 0 ? (
          <EmptyState
            data-testid="agreements-signed-empty"
            icon={<FileSignature className="h-10 w-10" strokeWidth={1.5} />}
            title="No signed agreements yet"
          >
            <p className="mt-1 text-sm text-muted-foreground">
              Signed copies of your agreements are kept here.
            </p>
          </EmptyState>
        ) : (
          <ul className={LIST} data-testid="agreements-signed-list">
            {signed.map((a) => (
              <li key={a.id} data-testid={`agreements-signed-row-${a.id}`} className={ITEM}>
                <div>
                  <p className="font-semibold text-foreground">{a.name}</p>
                  <p className={cn('text-figures text-xs text-muted-foreground sm:text-sm')}>
                    {shortDate(a.signedAt ?? a.createdAt, timezone)} · {sourceLine(a)}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <a
                    className={LINK}
                    data-testid={`agreements-signed-download-${a.id}`}
                    href={signedAgreementFilePath(a.id, 'certified')}
                  >
                    Signed copy
                  </a>
                  <a
                    className={LINK}
                    data-testid={`agreements-signed-original-${a.id}`}
                    href={signedAgreementFilePath(a.id, 'original')}
                  >
                    Original
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default AgreementList;
