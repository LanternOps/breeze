import { useEffect, useState } from 'react';
import { PRINT_LOGO_MIN_LONG_SIDE, logoPixelSize } from './logoDataUrl';

/** Pixel size of `src` when its long side is under the print minimum; otherwise null. */
export function useLowResLogo(src: string | null | undefined): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    let stale = false;
    setSize(null);
    if (!src) return;
    void logoPixelSize(src).then((measured) => {
      if (stale) return;
      setSize(measured && Math.max(measured.width, measured.height) < PRINT_LOGO_MIN_LONG_SIDE ? measured : null);
    });
    return () => {
      stale = true;
    };
  }, [src]);
  return size;
}
