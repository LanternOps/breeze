/**
 * Reads keyed by many source ids, in bounded `IN` lists (#8313): a ticket
 * may carry thousands of comments or files, and one `IN (…)` of all of them
 * would make one oversized statement. `read` runs once per slice of at most
 * `ID_SLICE` ids, in order; the rows are concatenated.
 */
export const ID_SLICE = 500;

export async function readInIdSlices<T>(ids: readonly string[], read: (slice: string[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += ID_SLICE) rows.push(...(await read(ids.slice(i, i + ID_SLICE))));
  return rows;
}
