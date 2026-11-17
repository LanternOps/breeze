/**
 * Cap at `max` code points (never mid surrogate pair), cutting at the last
 * paragraph break in the back half of the budget, else the last line break,
 * else the last space, else hard (only for text with no whitespace there);
 * marked with "…". A report normally loses whole paragraphs, not part of one.
 */
export function capAtBoundary(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, Math.max(0, max - 1)).join('');
  const floor = Math.floor(head.length / 2);
  const at = [head.lastIndexOf('\n\n'), head.lastIndexOf('\n'), head.search(/\s\S*$/)].find((i) => i >= floor);
  return `${(at === undefined ? head : head.slice(0, at)).trimEnd()}…`;
}
