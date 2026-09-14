import { buildReplacementSchedule, capNames, type HardwareLifecycleDeviceRow } from '@breeze/shared';

/**
 * The replacement schedule: one block per bucket from `buildReplacementSchedule`
 * (Now, each of the next four quarters, Later, and undated), listing device
 * names for the near-term buckets and just a count for the far-out ones.
 */
export function LifecycleSchedule({ rows }: { rows: HardwareLifecycleDeviceRow[] }) {
  const groups = buildReplacementSchedule(rows);
  if (groups.length === 0) return null;

  return (
    <section data-testid="lifecycle-schedule">
      {groups.map((group, index) => (
        <div key={`${group.label}-${index}`} data-testid={`lifecycle-schedule-group-${index}`} className="border-b border-border/70 py-3.5 last:border-b-0">
          <h3 className="font-display text-base font-semibold text-foreground">{group.label}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {group.countOnly
              ? `${group.rows.length} computer${group.rows.length === 1 ? '' : 's'}`
              : capNames(group.rows.map((r) => r.name))}
          </p>
        </div>
      ))}
    </section>
  );
}
