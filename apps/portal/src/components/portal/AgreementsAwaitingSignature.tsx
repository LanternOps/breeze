import { withBase } from '@/lib/basePath';
import { shortDate } from '@/lib/format';
import type { PortalAgreementSummary } from '@/lib/api';
import { LINK } from './ui';

interface AgreementsAwaitingSignatureProps {
  agreements: PortalAgreementSummary[];
  /** The org zone (the dashboard's `timezone`); the card is SSR-only (#10291). */
  timezone: string;
}

/** Dashboard card: agreements this user can sign right now. Renders nothing when there are none. */
export function AgreementsAwaitingSignature({ agreements, timezone }: AgreementsAwaitingSignatureProps) {
  const signable = agreements.filter((a) => a.canSign);
  if (signable.length === 0) return null;

  return (
    <section
      data-testid="dashboard-agreements-awaiting"
      aria-labelledby="dashboard-agreements-awaiting-heading"
      className="mb-6 rounded-xl border bg-card p-5"
    >
      <h2 id="dashboard-agreements-awaiting-heading" className="font-display text-lg font-semibold text-foreground">
        Awaiting your signature
      </h2>
      <ul className="mt-3 divide-y divide-border/70">
        {signable.map((a) => (
          <li key={a.id}>
            <a
              href={withBase(`/agreements/${a.id}`)}
              data-testid={`dashboard-agreements-awaiting-row-${a.id}`}
              className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm hover:underline"
            >
              <span className="font-semibold text-foreground">{a.name}</span>
              <span className="text-figures text-xs text-muted-foreground">Expires {shortDate(a.expiresAt, timezone)}</span>
            </a>
          </li>
        ))}
      </ul>
      <a href={withBase('/agreements')} data-testid="dashboard-agreements-awaiting-all" className={`${LINK} mt-3 inline-block text-sm`}>
        View all agreements
      </a>
    </section>
  );
}

export default AgreementsAwaitingSignature;
