import { forwardRef } from 'react';
import { glyphTileUri, type TopologyGlyph } from './topologyGlyphs';

export type NodeChip = { id: string; title: string; detail: string | null; glyph: TopologyGlyph };

/**
 * Zoomed-out labels for the nodes outside cards: gateways, the Internet, loose tiles (semantic zoom,
 * 2026-10-03). Like the card summaries they are HTML at a fixed screen size, so a gateway reads at
 * Fit map instead of shrinking to ~10px canvas text. The canvas places each `[data-node-id]` box
 * centred on its node and at least as large as the node, so the chip covers it and the node's edges
 * visibly meet the chip.
 */
const NodeChipOverlay = forwardRef<HTMLDivElement, { chips: NodeChip[]; visible: boolean; selectedId?: string; onSelect: (id: string) => void }>(function NodeChipOverlay({ chips, visible, selectedId, onSelect }, ref) {
  return <div ref={ref} data-testid="topology-node-chips" className="pointer-events-none absolute inset-0 overflow-hidden" hidden={!visible}>
    {chips.map((chip) => <div key={chip.id} data-node-id={chip.id} className="absolute left-0 top-0 flex items-center justify-center">
      <button type="button" data-testid="topology-node-chip" aria-pressed={chip.id === selectedId} aria-label={[chip.title, chip.detail].filter(Boolean).join(', ')} onClick={() => onSelect(chip.id)}
        className="pointer-events-auto flex h-full w-full items-center gap-2 whitespace-nowrap rounded-lg border border-primary/40 bg-card px-2.5 py-1.5 text-left shadow-[0_1px_2px_hsl(var(--foreground)/0.06)] transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary aria-pressed:border-primary aria-pressed:ring-1 aria-pressed:ring-primary">
        <img src={glyphTileUri(chip.glyph)} alt="" className="h-5 w-5 shrink-0" />
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold leading-4 tracking-[-0.01em] text-foreground">{chip.title}</span>
          {chip.detail && <span className="block text-[11px] leading-4 text-muted-foreground">{chip.detail}</span>}
        </span>
      </button>
    </div>)}
  </div>;
});
export default NodeChipOverlay;
