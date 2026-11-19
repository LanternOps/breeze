import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Height that makes `ref` end exactly at the bottom of its scrolling <main>,
 * whatever sits above it there (page banners, notices). The ticket workspace
 * needs a bounded height so the thread scrolls and the composer stays pinned;
 * `h-full` alone overflowed by the height of any banner above the island.
 * Returns undefined until measured (and where there is nothing to measure),
 * so the element keeps its CSS height.
 */
export function useFillAvailableHeight(ref: RefObject<HTMLElement | null>, minHeight = 420): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);

  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    const main = el?.closest('main');
    if (!el || !main) return;
    const measure = () => {
      if (main.clientHeight === 0) return;
      const mainBox = main.getBoundingClientRect();
      const top = el.getBoundingClientRect().top - mainBox.top + main.scrollTop;
      const padBottom = parseFloat(getComputedStyle(main).paddingBottom) || 0;
      const next = Math.max(minHeight, Math.floor(main.clientHeight - top - padBottom));
      setHeight((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(main);
    // Content above the island (a banner island hydrating late, or one being
    // dismissed) moves our top without resizing main. Islands are
    // display:contents, so a ResizeObserver cannot see them; watch the DOM
    // outside our own subtree instead.
    let frame = 0;
    const mo = typeof MutationObserver === 'function'
      ? new MutationObserver((records) => {
          if (records.every((r) => el.contains(r.target))) return;
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(measure);
        })
      : null;
    mo?.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      mo?.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
    };
  }, [ref, minHeight]);

  return height;
}
