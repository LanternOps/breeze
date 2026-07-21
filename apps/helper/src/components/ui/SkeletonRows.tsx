/**
 * Row-shaped loading placeholder for the Files list-table — a name bar and a
 * shorter meta bar per row, shimmering between the subtle-border and canvas
 * tokens. Replaces the old spinner + "Loading..." row in every Files view.
 */
export function SkeletonRows({ count = 8 }: { count?: number }) {
  return (
    <div className="ws-skeleton-rows" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="ws-skeleton-row">
          <span className="ws-skeleton-bar ws-skeleton-bar-name" />
          <span className="ws-skeleton-bar ws-skeleton-bar-meta" />
        </div>
      ))}
    </div>
  );
}
