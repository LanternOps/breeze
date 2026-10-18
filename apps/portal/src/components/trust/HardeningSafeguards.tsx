// Owner: W03e. The CIS v8 safeguards a hardening control evidences, as a collapsed disclosure under that control.
// Identifier + Breeze's own label + status only; labels come from @breeze/shared (crosswalk), never from the
// payload, and no Benchmark check title or id exists here (spec §5.5, §18.13). Rendered only while the payload
// carries `safeguards`, which the API emits only behind the CIS framework view switch.
import { FRAMEWORK_CROSSWALK, FRAMEWORK_META, trustCopyFor, type TrustPagePublicControl } from '@breeze/shared';
import { TrustStatusPill } from './TrustStatusPill';
import { hardeningSafeguardsCopy } from './hardeningSafeguardsCopy';
import { coverageNote } from './trustPageFormat';
import { pickTrustCopy, useTrustLocale } from './trustCopy';

export default function HardeningSafeguards({ control }: { control: TrustPagePublicControl }) {
  const locale = useTrustLocale();
  const copy = pickTrustCopy(hardeningSafeguardsCopy, locale);
  const safeguards = control.safeguards ?? [];
  if (control.id !== 'hardening_baseline' || safeguards.length === 0) return null;

  const labels = trustCopyFor(locale).crosswalk.cis_v8;
  return (
    <details className="mt-2 text-sm" data-testid="trust-hardening-safeguards">
      <summary className="cursor-pointer text-muted-foreground" data-testid="trust-hardening-safeguards-toggle">
        {copy.disclosure(safeguards.length)}
      </summary>
      <ul className="mt-2 divide-y rounded-md border bg-background">
        {safeguards.map((s) => {
          const note = coverageNote({ ...s, unit: 'devices' } as unknown as TrustPagePublicControl, locale);
          return (
            <li key={s.ref} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" data-testid={`trust-hardening-safeguard-${s.ref}`}>
              <span>
                <span className="font-mono text-xs text-muted-foreground">{FRAMEWORK_META.cis_v8.shortName} {s.ref}</span>
                {' · '}
                <span className="font-medium">{labels?.[s.ref] ?? FRAMEWORK_CROSSWALK.cis_v8[s.ref]?.label ?? s.ref}</span>
              </span>
              <span className="flex items-center gap-2">
                {note && <span className="text-xs text-muted-foreground">{note}</span>}
                <TrustStatusPill status={s.status} />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-xs text-muted-foreground" data-testid="trust-hardening-safeguards-note">{copy.note}</p>
    </details>
  );
}
