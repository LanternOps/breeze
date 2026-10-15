// Display scaling (#8241): Fit (scale the remote screen into the window, the
// only mode before W05) or Actual (100%: one remote pixel per CSS pixel, with
// scrollbars when the remote screen is larger than the window).
//
// Named "view scaling" to stay clear of the WebSocket stream's `scale`, which
// is the agent-side capture scale factor and a different thing entirely.
//
// Pointer mapping needs no mode switch: both scaleVideoCoords and the canvas
// path map from getBoundingClientRect(), which already reflects the scroll
// offset and the rendered size. noVNC maps its own pointer in either mode.

export type ViewScaling = 'fit' | 'actual';

export function isViewScaling(value: unknown): value is ViewScaling {
  return value === 'fit' || value === 'actual';
}

/** Classes for the <video>/<canvas> that shows the remote screen. */
export function mediaClassName(mode: ViewScaling): string {
  return mode === 'actual'
    ? 'shrink-0 m-auto max-w-none max-h-none'
    : 'max-w-full max-h-full object-contain';
}

/** Classes for the box that holds the media and scrolls it at 100%. */
export function scrollerClassName(mode: ViewScaling): string {
  return mode === 'actual'
    ? 'overflow-auto flex'
    : 'overflow-hidden flex items-center justify-center';
}
