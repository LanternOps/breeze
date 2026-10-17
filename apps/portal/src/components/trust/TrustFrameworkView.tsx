// Owner: W02e. Framework view: "evidence shown for N of M safeguards". Counts come from
// summarizeFrameworkCoverage (shared) so the numbers have one definition. Never a claim of compliance.
import { useEffect, useMemo, useState } from 'react';
import {
  FRAMEWORK_META, declaredControlById, summarizeFrameworkCoverage, trustControlById,
  type TrustControlStatus, type TrustFramework,
} from '@breeze/shared';
import { TrustStatusPill } from './TrustStatusPill';
import { frameworkCopy } from './frameworkCopy';
import { pickTrustCopy, useTrustLocale, type TrustSectionViewProps } from './trustCopy';

const HASH_PREFIX = '#framework-';

function frameworkFromHash(available: readonly TrustFramework[]): TrustFramework | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  if (!hash.startsWith(HASH_PREFIX)) return null;
  const id = hash.slice(HASH_PREFIX.length);
  return available.find((f) => f === id) ?? null;
}

export default function TrustFrameworkView({ payload }: TrustSectionViewProps) {
  const copy = pickTrustCopy(frameworkCopy, useTrustLocale());
  const frameworks = payload.frameworks;
  const [selected, setSelected] = useState<TrustFramework | null>(frameworks[0] ?? null);

  // Tab state lives in location.hash (repo convention); read after mount so SSR and hydration agree.
  useEffect(() => {
    const sync = () => { const fw = frameworkFromHash(frameworks); if (fw) setSelected(fw); };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [frameworks]);

  const active = selected && frameworks.includes(selected) ? selected : (frameworks[0] ?? null);
  const coverage = useMemo(() => (active ? summarizeFrameworkCoverage(payload, active) : null), [payload, active]);

  if (!active || !coverage) return null;
  const meta = FRAMEWORK_META[active];
  const select = (fw: TrustFramework) => {
    setSelected(fw);
    window.location.hash = `${HASH_PREFIX.slice(1)}${fw}`;
  };

  return (
    <section className="space-y-3" data-testid="trust-framework-view">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{copy.heading}</h2>
      <div role="tablist" className="flex flex-wrap gap-2">
        {frameworks.map((fw) => (
          <button
            key={fw}
            type="button"
            role="tab"
            aria-selected={fw === active}
            data-testid={`trust-framework-tab-${fw}`}
            onClick={() => select(fw)}
            className={`rounded-full border px-3 py-1 text-sm ${fw === active ? 'border-foreground bg-muted font-medium' : 'text-muted-foreground hover:bg-muted'}`}
          >
            {FRAMEWORK_META[fw].shortName}
          </button>
        ))}
      </div>
      <p className="text-sm" data-testid="trust-framework-summary">
        {copy.summary(coverage.evidenced, coverage.total, coverage.verified, coverage.declaredOnly)}{' '}
        <span className="text-muted-foreground">{copy.disclaimer}</span>
      </p>
      {coverage.safeguards.length === 0 ? (
        <p className="text-sm text-muted-foreground">{copy.noControls}</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card" data-testid={`trust-framework-safeguards-${active}`}>
          {coverage.safeguards.map((s) => (
            <li key={s.ref} className="space-y-1 px-4 py-3 text-sm" data-testid={`trust-framework-safeguard-${s.ref}`}>
              <p>
                <span className="font-mono text-xs text-muted-foreground">{s.ref}</span>{' '}
                <span className="font-medium">{s.label}</span>
                {s.ig != null && <span className="ml-2 rounded border px-1.5 py-0.5 text-xs text-muted-foreground">IG{s.ig}</span>}
              </p>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                {s.controls.map((c) => (
                  <li key={`${c.source}-${c.id}`} className="flex items-center gap-2">
                    <span>{c.source === 'telemetry' ? trustControlById(c.id as never)?.title ?? c.id : declaredControlById(c.id as never)?.title ?? c.id}</span>
                    {c.source === 'telemetry'
                      ? <TrustStatusPill status={c.status as TrustControlStatus} />
                      : (
                        <span className="inline-flex items-center rounded border border-dashed px-2 py-0.5 text-xs">
                          {c.counts ? copy.declaredBadge : copy.declaredExpired}
                        </span>
                      )}
                    {c.source === 'telemetry' && !c.counts && <span className="text-xs">{copy.notCounted}</span>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{meta.attribution}</p>
    </section>
  );
}
