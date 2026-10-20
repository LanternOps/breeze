/**
 * Remove declared additive keys from a JSON body so the rest can be compared
 * with a characterization pin (#9402 W1b). Paths are dotted; `[]` maps over an
 * array: `data.lines[].id` deletes `id` from every element of `data.lines`.
 * A declared path that is absent from the body throws, so a pin can never pass
 * because the key it claims was added silently went missing.
 */
export function stripAdditive<T>(body: T, paths: readonly string[]): T {
  const copy = JSON.parse(JSON.stringify(body)) as T;
  for (const path of paths) {
    const removed = remove(copy, path.split('.'));
    if (removed === 0) throw new Error(`stripAdditive: declared additive key "${path}" is not in the body`);
  }
  return copy;
}

function remove(node: unknown, parts: string[]): number {
  if (node === null || typeof node !== 'object') return 0;
  const [head, ...rest] = parts;
  if (head === undefined) return 0;
  const isArr = head.endsWith('[]');
  const key = isArr ? head.slice(0, -2) : head;
  const obj = node as Record<string, unknown>;
  if (!(key in obj)) return 0;
  if (rest.length === 0 && !isArr) { delete obj[key]; return 1; }
  if (isArr) {
    const arr = obj[key];
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    for (const el of arr) n += remove(el, rest);
    return arr.length === 0 ? 1 : (n === arr.length ? n : 0);
  }
  return remove(obj[key], rest);
}
