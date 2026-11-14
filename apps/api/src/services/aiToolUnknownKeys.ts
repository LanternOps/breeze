/**
 * Unknown-argument detection for AI tool input (#11861).
 *
 * Most tool schemas are plain `z.object(...)`, which STRIPS an unknown key:
 * the call succeeds and the argument the caller meant is silently ignored
 * (`query_devices` with `{ filter }` returned an unfiltered page). This walks
 * an input alongside its schema and reports every key the schema does not
 * define, so the validator can refuse the call with a message that names the
 * key and lists the accepted ones, and the model can correct itself.
 *
 * Which objects are checked:
 *  - a plain object (strip) or strict object, at the top level or nested under
 *    optional/nullable/default/readonly/catch wrappers, arrays, the input side
 *    of a pipe (or the output side of a preprocess), and lazy schemas;
 *  - a discriminated union: the arm the discriminator selects, or, when the
 *    discriminator is absent or matches no arm, the union of every arm's keys
 *    (a key no arm defines can never be applied).
 * Deliberately NOT checked, because open keys are their contract: records,
 * passthrough/loose objects and objects with a catchall, plain unions,
 * intersections, `any`/`unknown`.
 *
 * A key whose value is `undefined` is not reported: JSON cannot carry it, so
 * it can only come from an internal caller spreading an absent optional, and
 * it is as absent as a missing key.
 *
 * Pure: no I/O, never throws on malformed input (a value of the wrong type is
 * left to the schema's own type issues).
 */
import type { z } from 'zod';

export interface UnknownKeyFinding {
  /** Path of the object that carries the unknown keys ([] = top level). */
  path: Array<string | number>;
  /** The unknown keys, in input order. */
  keys: string[];
  /** The keys the schema accepts at that path, in schema order. */
  accepted: string[];
}

type AnyDef = {
  type: string;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  innerType?: z.ZodType;
  element?: z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
  getter?: () => z.ZodType;
  options?: z.ZodType[];
  discriminator?: string;
  values?: unknown[];
};

const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'readonly', 'catch', 'nonoptional']);
const MAX_DEPTH = 32;

function defOf(schema: unknown): AnyDef | undefined {
  return (schema as { _zod?: { def?: AnyDef } } | undefined)?._zod?.def;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The schema an object schema resolves to once wrappers are peeled, or undefined. */
function objectDef(schema: z.ZodType | undefined): AnyDef | undefined {
  let def = defOf(schema);
  for (let i = 0; def && i < MAX_DEPTH; i++) {
    if (def.type === 'object') return def;
    if (WRAPPERS.has(def.type)) def = defOf(def.innerType);
    else if (def.type === 'pipe') def = defOf(defOf(def.in)?.type === 'transform' ? def.out : def.in);
    else if (def.type === 'lazy' && def.getter) def = defOf(def.getter());
    else return undefined;
  }
  return undefined;
}

/** Values a discriminator field of an arm accepts (literal / enum), or [] when unknowable. */
function discriminatorValues(arm: AnyDef, key: string): unknown[] {
  let def = defOf(arm.shape?.[key]);
  for (let i = 0; def && i < MAX_DEPTH && WRAPPERS.has(def.type); i++) def = defOf(def.innerType);
  if (!def) return [];
  if (def.type === 'literal') return def.values ?? [];
  if (def.type === 'enum') return Object.values((def as { entries?: Record<string, unknown> }).entries ?? {});
  return [];
}

/** True when an object schema rejects or strips unknown keys (no open catchall). */
function closedObject(def: AnyDef): boolean {
  return !def.catchall || defOf(def.catchall)?.type === 'never';
}

export function findUnknownInputKeys(schema: z.ZodType, input: unknown): UnknownKeyFinding[] {
  const out: UnknownKeyFinding[] = [];

  const visitObject = (def: AnyDef, value: Record<string, unknown>, path: Array<string | number>, depth: number) => {
    const shape = def.shape ?? {};
    if (closedObject(def)) {
      const unknown = Object.keys(value).filter((k) => !Object.hasOwn(shape, k) && value[k] !== undefined);
      if (unknown.length > 0) out.push({ path, keys: unknown, accepted: Object.keys(shape) });
    }
    for (const [key, child] of Object.entries(shape)) {
      if (Object.hasOwn(value, key)) visit(child, value[key], [...path, key], depth + 1);
    }
  };

  const visit = (schema: z.ZodType | undefined, value: unknown, path: Array<string | number>, depth: number): void => {
    const def = defOf(schema);
    if (!def || depth > MAX_DEPTH || value === undefined || value === null) return;
    switch (def.type) {
      case 'object':
        if (isPlainRecord(value)) visitObject(def, value, path, depth);
        return;
      case 'array':
        if (Array.isArray(value)) value.forEach((item, i) => visit(def.element, item, [...path, i], depth + 1));
        return;
      case 'pipe':
        // A preprocess is pipe(transform, schema): the input is checked against
        // the schema it feeds. Otherwise the input side is what the caller sends.
        visit(defOf(def.in)?.type === 'transform' ? def.out : def.in, value, path, depth);
        return;
      case 'lazy':
        if (def.getter) visit(def.getter(), value, path, depth);
        return;
      case 'union': {
        if (!def.discriminator || !isPlainRecord(value)) return;
        const arms = (def.options ?? []).map(objectDef);
        if (arms.some((a) => !a)) return;
        const disc = value[def.discriminator];
        const arm = arms.find((a) => discriminatorValues(a!, def.discriminator!).includes(disc));
        if (arm) {
          visitObject(arm, value, path, depth);
          return;
        }
        if (!arms.every((a) => closedObject(a!))) return;
        const accepted = [...new Set(arms.flatMap((a) => Object.keys(a!.shape ?? {})))];
        const unknown = Object.keys(value).filter((k) => !accepted.includes(k) && value[k] !== undefined);
        if (unknown.length > 0) out.push({ path, keys: unknown, accepted });
        return;
      }
      default:
        if (WRAPPERS.has(def.type)) visit(def.innerType, value, path, depth);
    }
  };

  visit(schema, input, [], 0);
  return out;
}

function formatPath(path: Array<string | number>): string {
  return path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? p : `.${p}`)).join('');
}

/**
 * One finding as a validator issue line, e.g.
 * `unknown argument "filter" (accepted: search, siteId, limit)` or
 * `subject: unknown argument "foo" (accepted: kind, id)`.
 */
export function formatUnknownKeyFinding(finding: UnknownKeyFinding): string {
  const noun = finding.keys.length === 1 ? 'unknown argument' : 'unknown arguments';
  const keys = finding.keys.map((k) => JSON.stringify(k)).join(', ');
  const accepted = finding.accepted.length > 0 ? finding.accepted.join(', ') : 'none';
  const where = finding.path.length > 0 ? `${formatPath(finding.path)}: ` : '';
  return `${where}${noun} ${keys} (accepted: ${accepted})`;
}

/** Stable key for matching a finding's path against a Zod issue's path. */
export function unknownKeyPathKey(path: ReadonlyArray<PropertyKey>): string {
  return JSON.stringify(path.map((p) => (typeof p === 'symbol' ? String(p) : p)));
}
