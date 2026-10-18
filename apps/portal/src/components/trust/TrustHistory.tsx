// Owner: W02f (90-day controls-met history). A step chart drawn only from SVG attributes (CSP forbids inline
// style=). The snapshot stores change-points; the renderer appends the current point at lastEvaluatedAt and
// clamps to the last 90 days (the newest older point becomes the baseline at the window start). The caption
// claims change-points only, never uninterrupted verification.
import { CONTENT_COPY } from './contentCopy';
import { formatTrustDate, pickTrustCopy, useTrustLocale, type TrustSectionViewProps } from './trustCopy';

const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const W = 600;
const H = 160;
const PAD_X = 10;
const PAD_Y = 12;

interface Pt { t: number; met: number; shown: number }

export default function TrustHistory({ payload, lastEvaluatedAt }: TrustSectionViewProps) {
  const locale = useTrustLocale();
  const copy = pickTrustCopy(CONTENT_COPY, locale);
  // showHistory off (or no earlier snapshot) means the payload carries no history: render nothing.
  if (payload.history.length === 0) return null;

  const end = Date.parse(lastEvaluatedAt ?? payload.generatedAt);
  if (Number.isNaN(end)) return null;
  const start = end - WINDOW_MS;

  const stored: Pt[] = payload.history
    .map((p) => ({ t: Date.parse(p.at), met: p.met, shown: p.shown }))
    .filter((p) => !Number.isNaN(p.t) && p.t <= end)
    .sort((a, b) => a.t - b.t);
  const before = stored.filter((p) => p.t < start);
  const baseline = before.length > 0 ? [{ ...before[before.length - 1]!, t: start }] : [];
  const points: Pt[] = [
    ...baseline,
    ...stored.filter((p) => p.t >= start),
    { t: end, met: payload.summary.controlsMet, shown: payload.summary.controlsShown },
  ];

  const maxShown = Math.max(1, ...points.map((p) => p.shown));
  const x = (t: number) => PAD_X + ((t - start) / WINDOW_MS) * (W - 2 * PAD_X);
  const y = (met: number) => H - PAD_Y - (Math.min(met, maxShown) / maxShown) * (H - 2 * PAD_Y);
  const first = points[0]!;
  const path = points.slice(1).reduce(
    (d, p) => `${d} H ${x(p.t).toFixed(1)} V ${y(p.met).toFixed(1)}`,
    `M ${x(first.t).toFixed(1)} ${y(first.met).toFixed(1)}`,
  );
  const last = points[points.length - 1]!;

  return (
    <section data-testid="trust-history" className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{copy.historyHeading}</h2>
      <div className="rounded-lg border bg-card p-4">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={copy.historySummary(last.met, last.shown)} className="h-40 w-full text-primary">
          <line x1={PAD_X} y1={H - PAD_Y} x2={W - PAD_X} y2={H - PAD_Y} className="stroke-border" strokeWidth="1" />
          <path d={path} fill="none" className="stroke-current" strokeWidth="2" strokeLinejoin="round" />
          {points.map((p, i) => (
            <circle key={i} cx={x(p.t).toFixed(1)} cy={y(p.met).toFixed(1)} r="3" className="fill-current" data-testid="trust-history-point" data-met={p.met} data-shown={p.shown} />
          ))}
        </svg>
        <div className="mt-1 flex justify-between text-xs text-muted-foreground">
          <span>{formatTrustDate(new Date(start).toISOString(), locale)}</span>
          <span>{copy.historySummary(last.met, last.shown)}</span>
          <span>{formatTrustDate(new Date(end).toISOString(), locale)}</span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{copy.historyCaption}</p>
      </div>
    </section>
  );
}
