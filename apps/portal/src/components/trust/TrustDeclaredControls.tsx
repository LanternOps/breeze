// Owner: W02b (declared controls: "Declared by <partner> on <date>", current/expired). Spec §18.2, amendment 27.
// A declared control never shares a pill style, a status value or a count with a telemetry control: it gets an
// outlined "Declared" marker (never TrustStatusPill), and an expired one is shown muted with its expiry date
// (Open Decision 4) rather than hidden. The statement is plain text. Copy goes through defineTrustCopy, never
// i18next; no inline style=.
import { declaredControlById, trustCopyFor, type DeclaredControlId } from '@breeze/shared';
import { declaredCopy } from './declaredCopy';
import { frameworkChip } from './trustPageFormat';
import { formatTrustDate, pickTrustCopy, useTrustLocale, type TrustSectionViewProps } from './trustCopy';

/** W02h's shared control copy when it is present; else the declared catalog's English. */
function declaredTitle(id: DeclaredControlId, locale: string): string {
  const shared = trustCopyFor(locale) as unknown as { controls?: Partial<Record<string, { title?: string }>> } | null;
  return shared?.controls?.[id]?.title ?? declaredControlById(id)?.title ?? id;
}

export default function TrustDeclaredControls({ payload }: TrustSectionViewProps) {
  const locale = useTrustLocale();
  const declared = payload.declaredControls ?? [];
  if (declared.length === 0) return null;
  const copy = pickTrustCopy(declaredCopy, locale);
  const documents = new Map((payload.documents ?? []).map((d) => [d.id, d]));

  return (
    <section className="space-y-2" data-testid="trust-declared-controls">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{copy.heading}</h2>
      <p className="text-sm text-muted-foreground">{copy.intro}</p>
      <ul className="divide-y rounded-lg border bg-card">
        {declared.map((d) => {
          const expired = d.status === 'expired';
          const evidence = d.evidenceDocumentId ? documents.get(d.evidenceDocumentId) : undefined;
          return (
            <li
              key={d.id}
              data-testid={`trust-declared-${d.id}`}
              data-status={d.status}
              className={expired ? 'space-y-1 px-4 py-3 opacity-60' : 'space-y-1 px-4 py-3'}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="font-medium">{declaredTitle(d.id, locale)}</p>
                {!expired && (
                  <span
                    className="rounded border border-dashed px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                    data-testid={`trust-declared-${d.id}-marker`}
                  >
                    {copy.marker}
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm">{d.statement}</p>
              <p className="text-xs text-muted-foreground">
                {expired
                  ? copy.expiredOn(formatTrustDate(d.expiresAt, locale))
                  : copy.declaredBy(d.declaredBy, formatTrustDate(d.declaredAt, locale))}
              </p>
              {evidence && <p className="text-xs text-muted-foreground">{copy.evidence(evidence.title)}</p>}
              {d.frameworkRefs.length > 0 && (
                <p className="flex flex-wrap gap-1">
                  {d.frameworkRefs.map((r) => (
                    <span key={`${r.framework}:${r.ref}`} className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{frameworkChip(r)}</span>
                  ))}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
