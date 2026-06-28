import { Cpu, LayoutGrid, Network } from 'lucide-react';
import type { ComponentType } from 'react';
import type { DeviceClassFilter } from './deviceClassFilter';

type DeviceClassSegmentProps = {
  value: DeviceClassFilter;
  counts: { all: number; agent: number; network: number };
  onChange: (value: DeviceClassFilter) => void;
};

// Icons mirror the Class column in DeviceList (Cpu = agent, Network = network)
// so the segment and the per-row badge read as the same vocabulary.
const SEGMENTS: Array<{
  id: DeviceClassFilter;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { id: 'all', label: 'All', icon: LayoutGrid },
  { id: 'agent', label: 'Agent', icon: Cpu },
  { id: 'network', label: 'Network', icon: Network },
];

/**
 * Single-select class segment for the unified Devices list (#1424):
 * `[ All | Agent | Network ]`, each with a live count. Purely presentational —
 * the parent owns the selected value, the merged-list counts, and hash
 * persistence (see deviceClassFilter.ts).
 */
export function DeviceClassSegment({ value, counts, onChange }: DeviceClassSegmentProps) {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-md border bg-muted/30 p-0.5"
      role="group"
      aria-label="Filter by device class"
      data-testid="device-class-segment"
    >
      {SEGMENTS.map(({ id, label, icon: Icon }) => {
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            data-testid={`device-class-segment-${id}`}
            aria-pressed={active}
            onClick={() => onChange(id)}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
            <span
              className={`rounded-full px-1.5 text-xs tabular-nums ${
                active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
              }`}
            >
              {counts[id]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
