import { useCallback, useEffect, useMemo, useState } from 'react';
import { Grip, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type GridItem = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  isDraggable?: boolean;
};

type Dashboard = {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  layout: Record<string, unknown>;
  widgetIds: string[];
  createdAt: string;
  updatedAt: string;
};

type DashboardGridProps = {
  layout?: GridItem[];
  dashboardId?: string;
  columns?: number;
  rowHeight?: number;
  gap?: number;
  isDraggable?: boolean;
  className?: string;
  onLayoutChange?: (layout: GridItem[]) => void;
  onDashboardLoad?: (dashboard: Dashboard) => void;
  renderItem: (item: GridItem) => React.ReactNode;
};

export default function DashboardGrid({
  layout,
  dashboardId,
  columns = 12,
  rowHeight = 72,
  gap = 16,
  isDraggable = true,
  className,
  onLayoutChange,
  onDashboardLoad,
  renderItem
}: DashboardGridProps) {
  const [internalLayout, setInternalLayout] = useState<GridItem[]>(layout || []);
  const [dragId, setDragId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const fetchDashboard = useCallback(async () => {
    if (!dashboardId) return;

    setLoading(true);
    setError(undefined);

    try {
      const response = await fetchWithAuth(`/api/analytics/dashboards/${dashboardId}`);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const dashboard: Dashboard = await response.json();
      onDashboardLoad?.(dashboard);

      // Convert dashboard layout to GridItem array if available
      if (dashboard.layout && typeof dashboard.layout === 'object') {
        const layoutItems = Object.entries(dashboard.layout).map(([key, value]) => {
          const item = value as Record<string, unknown>;
          return {
            i: key,
            x: Number(item.x) || 0,
            y: Number(item.y) || 0,
            w: Number(item.w) || 1,
            h: Number(item.h) || 1,
            isDraggable: item.isDraggable !== false
          };
        });
        setInternalLayout(layoutItems);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, [dashboardId, onDashboardLoad]);

  useEffect(() => {
    if (dashboardId) {
      fetchDashboard();
    }
  }, [dashboardId, fetchDashboard]);

  useEffect(() => {
    if (layout) {
      setInternalLayout(layout);
    }
  }, [layout]);

  const orderedLayout = useMemo(
    () => [...internalLayout].sort((a, b) => (a.y - b.y) || (a.x - b.x)),
    [internalLayout]
  );

  const commitLayout = (nextLayout: GridItem[]) => {
    setInternalLayout(nextLayout);
    onLayoutChange?.(nextLayout);
  };

  const handleDrop = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    const nextLayout = internalLayout.map(item => ({ ...item }));
    const source = nextLayout.find(item => item.i === sourceId);
    const target = nextLayout.find(item => item.i === targetId);
    if (!source || !target) return;

    const temp = { x: source.x, y: source.y, w: source.w, h: source.h };
    source.x = target.x;
    source.y = target.y;
    source.w = target.w;
    source.h = target.h;
    target.x = temp.x;
    target.y = temp.y;
    target.w = temp.w;
    target.h = temp.h;

    commitLayout(nextLayout);
  };

  if (loading) {
    return (
      <div className={cn('flex h-64 items-center justify-center rounded-lg border bg-muted/30', className)}>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn('flex h-64 flex-col items-center justify-center rounded-lg border border-destructive/40 bg-destructive/10', className)}>
        <p className="text-sm text-destructive">{error}</p>
        {dashboardId && (
          <button
            type="button"
            onClick={fetchDashboard}
            className="mt-2 text-sm text-primary hover:underline"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn('grid w-full auto-rows-max', className)}
      style={{
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridAutoRows: `${rowHeight}px`,
        gap
      }}
    >
      {orderedLayout.map(item => {
        const draggable = isDraggable && item.isDraggable !== false;

        return (
          <div
            key={item.i}
            className={cn(
              'group relative rounded-lg border bg-card shadow-sm transition',
              dragId === item.i ? 'ring-2 ring-primary/40' : 'hover:border-primary/30'
            )}
            style={{
              gridColumnStart: item.x + 1,
              gridColumnEnd: `span ${item.w}`,
              gridRowStart: item.y + 1,
              gridRowEnd: `span ${item.h}`
            }}
            draggable={draggable}
            onDragStart={event => {
              if (!draggable) return;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', item.i);
              setDragId(item.i);
            }}
            onDragEnd={() => setDragId(null)}
            onDragOver={event => {
              if (!draggable) return;
              event.preventDefault();
            }}
            onDrop={event => {
              event.preventDefault();
              const sourceId = event.dataTransfer.getData('text/plain');
              setDragId(null);
              if (sourceId) {
                handleDrop(sourceId, item.i);
              }
            }}
          >
            {draggable && (
              <div className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-background/80 px-2 py-1 text-[10px] text-muted-foreground opacity-0 shadow-sm transition group-hover:opacity-100">
                <Grip className="h-3 w-3" />
                Drag
              </div>
            )}
            <div className="h-full w-full p-4">
              {renderItem(item)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export type { GridItem, DashboardGridProps, Dashboard };
