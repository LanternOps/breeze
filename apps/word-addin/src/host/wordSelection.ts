/**
 * Word selection plumbing — the ONLY place the selection chip touches the
 * `Word.*` / `Office.context` object model. Mirrors Excel's host/excelSelection
 * so the core's neutral selection hook works unchanged: a one-shot label read +
 * a change subscription.
 *
 * Word has no cell address, so the "selection address" the core shows is a short
 * snippet of the selected text instead. Both functions are wired into the Word
 * HostAdapter (host/word.ts).
 */

/** Max characters of selected text shown in the chip before truncation. */
const SELECTION_LABEL_CAP = 60;

/**
 * One-shot read of the current selection as a short text snippet. Never throws —
 * a failed read or empty selection resolves to undefined ("no selection"), so it
 * can never block the UI.
 */
export async function captureWordSelectionLabel(): Promise<string | undefined> {
  try {
    return await Word.run(async (context) => {
      const selection = context.document.getSelection();
      selection.load('text');
      await context.sync();
      const text = selection.text?.trim();
      if (!text) return undefined;
      return text.length > SELECTION_LABEL_CAP ? `${text.slice(0, SELECTION_LABEL_CAP)}…` : text;
    });
  } catch {
    return undefined;
  }
}

/**
 * Subscribe to Word's `DocumentSelectionChanged` so the core can re-read the
 * selection snippet on every change. Mirrors Excel: returns a no-op unsubscribe
 * (the always-mounted subscriber guards late updates itself).
 */
export function subscribeWordSelectionChanged(cb: () => void): () => void {
  const officeGlobal = (globalThis as { Office?: typeof Office }).Office;
  officeGlobal?.context?.document?.addHandlerAsync(
    officeGlobal.EventType.DocumentSelectionChanged,
    cb,
    () => undefined,
  );
  return () => undefined;
}
