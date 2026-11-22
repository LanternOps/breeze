import { z } from 'zod';

/**
 * Length checks pinned to the unit a downstream sink counts (#9976).
 *
 * Since zod 4.6, `z.string().max(N)` / `.min(N)` / `.length(N)` count Unicode
 * CODE POINTS. That is the right unit for Postgres `varchar(N)` / `text`, which
 * count characters, so most limits need nothing. It is the wrong unit when the
 * value lands somewhere that counts something else:
 *
 *  - `utf8MaxBytes(N)`: Go `len(s)` (the agent's own payload guards), byte
 *    buffers, and other UTF-8 byte budgets. N code points can be 4N bytes.
 *  - `utf16Max(N)`: Windows wide-char (wchar) buffers and APIs, .NET / SQL
 *    Server `nvarchar` limits, JavaScript `String.length` budgets. N code points
 *    can be 2N UTF-16 units.
 *
 * Use with `.check()` and keep the `.max(N)` beside it: `.max` still feeds
 * `maxLength` into generated JSON Schema (AI tool definitions, OpenAPI). The
 * helper adds the sink-unit bound:
 *
 *   z.string().min(1).max(200).check(utf8MaxBytes(200, 'name exceeds 200 bytes'))
 *
 * A failure raises the same `too_big` issue shape as `.max()` (origin
 * `string`), so error formatting and localized messages stay unchanged unless a
 * message is passed. Contract: `apps/api/src/__tests__/zodUnitLength.contract.test.ts`.
 */
export type UnitLengthParams = string | { message?: string; abort?: boolean };

const utf8 = new TextEncoder();

function unitMaxCheck(
  maximum: number,
  measure: (value: string) => number,
  params: UnitLengthParams | undefined,
): z.core.$ZodCheck<string> {
  const { message, abort } = typeof params === 'string' ? { message: params, abort: false } : (params ?? {});
  const check: z.core.$ZodCheck<string> = z.check<string>((payload) => {
    const value = payload.value;
    if (typeof value !== 'string' || measure(value) <= maximum) return;
    payload.issues.push({
      code: 'too_big',
      origin: 'string',
      maximum,
      inclusive: true,
      input: value,
      inst: check,
      continue: !abort,
      ...(message ? { message } : {}),
    });
  });
  return check;
}

/** Bound a string to at most `maximum` UTF-16 code units (`String.length`). */
export function utf16Max(maximum: number, params?: UnitLengthParams): z.core.$ZodCheck<string> {
  return unitMaxCheck(maximum, (value) => value.length, params);
}

/** Bound a string to at most `maximum` bytes once UTF-8 encoded. */
export function utf8MaxBytes(maximum: number, params?: UnitLengthParams): z.core.$ZodCheck<string> {
  return unitMaxCheck(maximum, (value) => utf8.encode(value).length, params);
}
