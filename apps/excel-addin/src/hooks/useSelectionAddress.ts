/**
 * Host-NEUTRAL live selection-address hook. Owns only the React rhythm; the
 * actual host plumbing is injected (Excel's lives in host/excelSelection.ts):
 *   - `captureSelectionAddress()` — one-shot read of the current selection label.
 *   - `subscribeSelectionChanged(cb)` — fires `cb` whenever the selection moves;
 *     returns an unsubscribe.
 *
 * Rhythm (the live-refresh that keeps the chip from freezing): read once on
 * mount, then re-read inside every `subscribeSelectionChanged` callback. The
 * `disposed` flag guards late setState; the cleanup calls the injected
 * unsubscribe (Excel's is a deliberate no-op — it never removes the handler).
 */
import { useEffect, useState } from 'react';

export type SelectionAddressSource = {
  captureSelectionAddress: () => Promise<string | undefined>;
  subscribeSelectionChanged: (cb: () => void) => () => void;
};

export function useSelectionAddress({
  captureSelectionAddress,
  subscribeSelectionChanged,
}: SelectionAddressSource): string | null {
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void captureSelectionAddress()
        .then((next) => {
          if (!disposed) setAddress(next ?? null);
        })
        .catch(() => undefined);
    };
    refresh();
    const unsubscribe = subscribeSelectionChanged(refresh);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [captureSelectionAddress, subscribeSelectionChanged]);
  return address;
}
