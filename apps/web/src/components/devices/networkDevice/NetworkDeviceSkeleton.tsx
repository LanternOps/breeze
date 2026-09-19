// Loading placeholder for the network device detail page. Mirrors the real
// layout (header card, stat strip, tab bar, two section cards) so the page
// doesn't jump once data arrives — a centered spinner over an otherwise-empty
// page reads as broken on a slow load.

export function NetworkDeviceSkeleton({ label }: { label: string }) {
  return (
    <div
      className="max-w-6xl space-y-6 animate-pulse motion-reduce:animate-none"
      data-testid="network-device-detail-loading"
      aria-busy="true"
      aria-label={label}
    >
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-start gap-4">
          <div className="h-14 w-14 shrink-0 rounded-lg bg-muted" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="h-5 w-48 rounded bg-muted" />
              <div className="h-5 w-16 rounded-full bg-muted" />
              <div className="h-5 w-16 rounded-full bg-muted" />
            </div>
            <div className="h-4 w-64 rounded bg-muted" />
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-lg border bg-card px-5 py-4 sm:flex-row sm:gap-6">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex-1 space-y-2">
            <div className="h-3 w-16 rounded bg-muted" />
            <div className="h-5 w-20 rounded bg-muted" />
          </div>
        ))}
      </div>

      <div className="flex gap-2 border-b pb-2">
        <div className="h-8 w-24 rounded bg-muted" />
        <div className="h-8 w-24 rounded bg-muted" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {[0, 1].map((card) => (
          <div key={card} className="space-y-3 rounded-md border bg-card p-4">
            <div className="h-4 w-24 rounded bg-muted" />
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center justify-between gap-4">
                <div className="h-3 w-20 rounded bg-muted" />
                <div className="h-3 w-24 rounded bg-muted" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
