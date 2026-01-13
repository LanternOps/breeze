import { useEffect, useMemo, useState } from 'react';
import { Grip } from 'lucide-react';
import { cn } from '@/lib/utils';

type GridItem = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  isDraggable?: boolean;
};

type DashboardGridProps = {
  layout: GridItem[];
  columns?: number;
  rowHeight?: number;
  gap?: number;
  isDraggable?: boolean;
  className?: string;
  onLayoutChange?: (layout: GridItem[]) => void;
  renderItem: (item: GridItem) => React.ReactNode;
};

export default function DashboardGrid({
  layout,
  columns = 12,
  rowHeight = 72,
  gap = 16,
  isDraggable = true,
  className,
  onLayoutChange,
  renderItem
}: DashboardGridProps) {
  const [internalLayout, setInternalLayout] = useState<GridItem[]>(layout);
  const [dragId, setDragId] = useState<string | null>(null);

  useEffect(() => {
    setInternalLayout(layout);
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

export type { GridItem, DashboardGridProps };
