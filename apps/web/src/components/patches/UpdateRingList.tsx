import { useMemo, useState } from 'react';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
  Rocket,
  Layers,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type UpdateRingStatus = 'active' | 'disabled';

export type UpdateRingItem = {
  id: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  ringOrder: number;
  deferralDays: number;
  deadlineDays?: number | null;
  gracePeriodHours: number;
  categories: string[];
  compliancePercent?: number;
  deviceCount?: number;
  updatedAt?: string;
};

type UpdateRingListProps = {
  rings: UpdateRingItem[];
  onEdit?: (ring: UpdateRingItem) => void;
  onDelete?: (ring: UpdateRingItem) => void;
  onDeploy?: (ring: UpdateRingItem) => void;
  onSelect?: (ring: UpdateRingItem) => void;
  pageSize?: number;
};

function formatDate(dateString?: string): string {
  if (!dateString) return '\u2014';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString();
}

function ComplianceBadge({ percent }: { percent?: number }) {
  if (percent === undefined) return <span className="text-muted-foreground">\u2014</span>;

  const color =
    percent >= 90
      ? 'bg-green-500/20 text-green-700 border-green-500/40'
      : percent >= 70
        ? 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40'
        : 'bg-red-500/20 text-red-700 border-red-500/40';

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
        color
      )}
    >
      {percent}%
    </span>
  );
}

export default function UpdateRingList({
  rings,
  onEdit,
  onDelete,
  onDeploy,
  onSelect,
  pageSize = 8,
}: UpdateRingListProps) {
  const [query, setQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  const filteredRings = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return rings.filter((ring) => {
      if (normalizedQuery.length === 0) return true;
      return (
        ring.name.toLowerCase().includes(normalizedQuery) ||
        ring.description?.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [rings, query]);

  const totalPages = Math.ceil(filteredRings.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedRings = filteredRings.slice(startIndex, startIndex + pageSize);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">Update Rings</h2>
            <p className="text-sm text-muted-foreground">
              {filteredRings.length} of {rings.length} rings
            </p>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder="Search rings..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-48"
          />
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Order</th>
              <th className="px-4 py-3">Ring</th>
              <th className="px-4 py-3">Deferral</th>
              <th className="px-4 py-3">Deadline</th>
              <th className="px-4 py-3">Devices</th>
              <th className="px-4 py-3">Compliance</th>
              <th className="px-4 py-3">Updated</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedRings.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-6 text-center text-sm text-muted-foreground"
                >
                  No update rings found.
                </td>
              </tr>
            ) : (
              paginatedRings.map((ring) => (
                <tr key={ring.id} className="text-sm">
                  <td className="px-4 py-3">
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                      {ring.ringOrder}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => onSelect?.(ring)}
                      className="text-left"
                    >
                      <div className="font-medium text-foreground hover:text-primary">
                        {ring.name}
                      </div>
                      {ring.description && (
                        <div className="text-xs text-muted-foreground line-clamp-1">
                          {ring.description}
                        </div>
                      )}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {ring.deferralDays === 0 ? 'None' : `${ring.deferralDays} days`}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {ring.deadlineDays == null ? 'None' : `${ring.deadlineDays} days`}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {ring.deviceCount ?? '\u2014'}
                  </td>
                  <td className="px-4 py-3">
                    <ComplianceBadge percent={ring.compliancePercent} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDate(ring.updatedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onDeploy?.(ring)}
                        className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                      >
                        <Rocket className="h-3.5 w-3.5" />
                        Deploy
                      </button>
                      <button
                        type="button"
                        onClick={() => onEdit?.(ring)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete?.(ring)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {currentPage} of {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
              disabled={currentPage === 1}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
              disabled={currentPage === totalPages}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
