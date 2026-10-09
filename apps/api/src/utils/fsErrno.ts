/** The `code` of a Node.js filesystem error (`ENOENT`, `EACCES`, ...), if it has one. */
export function errnoCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
}
