import { useMemo, useRef, useState } from 'react';

export interface SparkPoint {
  label: string;
  value: number;
}

const VIEW_W = 240;
const VIEW_H = 56;
const PAD_X = 4;
const PAD_Y = 6;

/**
 * Dependency-free single-series sparkline: 2px line, 10%-opacity area wash,
 * end dot with a surface ring, and a pointer-tracked tooltip. The SVG
 * stretches to the container (preserveAspectRatio="none") with non-scaling
 * strokes so the line keeps its 2px weight at any card width; the dot and
 * crosshair are HTML overlays positioned in percentages so they can't
 * distort under the non-uniform stretch — and so the pointer→point mapping
 * (which assumes viewBox x spans the full container width) stays exact.
 * The container height is fixed to VIEW_H, so y coordinates map 1:1.
 */
export default function Sparkline({
  points,
  color,
  min = 0,
  max = 100,
}: {
  points: SparkPoint[];
  /** CSS color for line/fill, e.g. 'hsl(var(--success))'. */
  color: string;
  min?: number;
  max?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const coords = useMemo(() => {
    if (points.length === 0) return [];
    const span = Math.max(max - min, 1);
    const innerW = VIEW_W - PAD_X * 2;
    const innerH = VIEW_H - PAD_Y * 2;
    return points.map((p, i) => ({
      x: PAD_X + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW),
      y: PAD_Y + innerH - ((Math.min(Math.max(p.value, min), max) - min) / span) * innerH,
    }));
  }, [points, min, max]);

  if (points.length < 2) return null;

  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${coords[coords.length - 1].x.toFixed(1)},${VIEW_H - PAD_Y} L${coords[0].x.toFixed(1)},${VIEW_H - PAD_Y} Z`;

  const active = hover != null ? hover : coords.length - 1;
  const activePoint = points[active];
  const activeCoord = coords[active];
  const activeLeftPct = (activeCoord.x / VIEW_W) * 100;

  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const d = Math.abs(coords[i].x - x);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    setHover(nearest);
  };

  return (
    <div
      ref={wrapRef}
      className="relative h-14 w-full"
      onPointerMove={handleMove}
      onPointerLeave={() => setHover(null)}
    >
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="block h-full w-full"
        aria-hidden="true"
      >
        <path d={areaPath} fill={color} opacity={0.1} />
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {hover != null && (
        <div
          className="pointer-events-none absolute w-px bg-border"
          style={{ left: `${activeLeftPct}%`, top: PAD_Y - 2, bottom: PAD_Y }}
          aria-hidden="true"
        />
      )}
      <div
        className="pointer-events-none absolute h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card"
        style={{ left: `${activeLeftPct}%`, top: activeCoord.y, backgroundColor: color }}
        aria-hidden="true"
      />
      {hover != null && (
        <div
          className="pointer-events-none absolute -top-7 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border bg-popover px-2 py-0.5 text-xs text-popover-foreground shadow-sm"
          style={{ left: `${activeLeftPct}%` }}
        >
          <span className="font-semibold tabular-nums">{activePoint.value}</span>
          <span className="text-muted-foreground"> · {activePoint.label}</span>
        </div>
      )}
    </div>
  );
}
