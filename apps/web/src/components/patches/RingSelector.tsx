import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export type UpdateRing = {
  id: string;
  name: string;
  ringOrder: number;
  deferralDays: number;
  enabled: boolean;
};

type RingSelectorProps = {
  rings: UpdateRing[];
  selectedRingId: string | null;
  onChange: (ringId: string | null) => void;
  loading?: boolean;
  className?: string;
};

export default function RingSelector({
  rings,
  selectedRingId,
  onChange,
  loading,
  className,
}: RingSelectorProps) {
  const sorted = [...rings].sort((a, b) => a.ringOrder - b.ringOrder);

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <label className="text-sm font-medium text-muted-foreground whitespace-nowrap">
        Update Ring:
      </label>
      <div className="relative">
        <select
          value={selectedRingId ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          disabled={loading}
          className="h-9 w-full appearance-none rounded-md border bg-background pl-3 pr-8 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 sm:w-52"
        >
          <option value="">All Rings</option>
          {sorted.map((ring) => (
            <option key={ring.id} value={ring.id}>
              {ring.name} (Order {ring.ringOrder}, +{ring.deferralDays}d)
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      </div>
    </div>
  );
}
