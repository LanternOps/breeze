/**
 * Detail-table truncation disclosure shared by the three #3198 business PDFs
 * (arAgingPdf, technicianTimePdf, ticketSlaPdf).
 *
 * Two caps stack: the generator stores at most `storedCap` detail rows
 * (`detail.cap`, the registry's `detailRowCap`), and each PDF draws at most
 * `pdfMax` of those. The heading states only what the PDF actually DRAWS
 * against the true total — never the stored count, which the reader cannot see
 * in the PDF — and a note names both caps. (#3198 W02 fix round, item 1.)
 */
export type DetailDisclosure = {
  /** Heading text, with "(showing N of M noun)" when anything is left out. */
  heading: string;
  /** Explanatory line naming both caps, or null when nothing is left out. */
  note: string | null;
};

export function detailDisclosure(input: {
  base: string;
  /** Rows the PDF has in hand for this table (the stored, possibly filtered set). */
  inHand: number;
  /** The true count this table stands for (e.g. `detail.available`, or the
   *  aggregate breach count). Never less than `inHand`. */
  total: number;
  pdfMax: number;
  storedCap: number;
  /** Plural noun for the count, e.g. "breaches"; omitted → bare numbers. */
  noun?: string;
}): DetailDisclosure {
  const drawn = Math.min(input.inHand, input.pdfMax);
  const total = Math.max(input.total, input.inHand);
  if (drawn >= total) return { heading: input.base, note: null };
  const noun = input.noun ? ` ${input.noun}` : '';
  return {
    heading: `${input.base} (showing ${drawn} of ${total}${noun})`,
    note: `This PDF lists at most ${input.pdfMax} rows; the stored report keeps at most `
      + `${input.storedCap}. Totals above are computed over all ${total}${noun}.`,
  };
}
