/**
 * Excel selection plumbing — the ONLY place the selection chip touches the
 * `Excel.*` / `Office.context` object model. Moved out of the (now host-neutral)
 * `hooks/useSelectionAddress.ts` so the core never imports a host API.
 *
 * Both functions are wired into the Excel `HostAdapter` (see host/excel.ts) and
 * consumed by the neutral `useSelectionAddress` hook via injection.
 */

/**
 * One-shot read of the current Excel selection as a sheet-qualified address
 * (e.g. `Sheet1!B2`). Never throws — a failed read resolves to undefined
 * ("no selection"), so it can never block the UI.
 */
export async function captureExcelSelectionAddress(): Promise<string | undefined> {
  try {
    return await Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      range.load('address');
      await context.sync();
      return range.address;
    });
  } catch {
    return undefined;
  }
}

/**
 * Subscribe to Excel's `DocumentSelectionChanged` so the core can re-read the
 * selection address on every change. Intentionally NEVER removes the handler —
 * the subscriber (the always-mounted Composer) guards late updates itself — so
 * the returned unsubscribe is a no-op, preserving the legacy behavior.
 */
export function subscribeExcelSelectionChanged(cb: () => void): () => void {
  const officeGlobal = (globalThis as { Office?: typeof Office }).Office;
  officeGlobal?.context?.document?.addHandlerAsync(
    officeGlobal.EventType.DocumentSelectionChanged,
    cb,
    () => undefined,
  );
  return () => undefined;
}
