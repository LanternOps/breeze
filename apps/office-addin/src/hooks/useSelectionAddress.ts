/**
 * Live sheet-qualified selection address via DocumentSelectionChanged.
 * No removeHandlerAsync on unmount: the hook lives in the always-mounted
 * Composer; the `disposed` flag guards late setState.
 */
import { useEffect, useState } from 'react';

export function useSelectionAddress(): string | null {
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void Excel.run(async (context) => {
        const range = context.workbook.getSelectedRange();
        range.load('address');
        await context.sync();
        if (!disposed) setAddress(range.address);
      }).catch(() => undefined);
    };
    refresh();
    const officeGlobal = (globalThis as { Office?: typeof Office }).Office;
    officeGlobal?.context?.document?.addHandlerAsync(
      officeGlobal.EventType.DocumentSelectionChanged,
      refresh,
      () => undefined,
    );
    return () => {
      disposed = true;
    };
  }, []);
  return address;
}
