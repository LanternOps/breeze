import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  describeFirstZodIssue,
  describeZodIssues,
  flattenZodIssues,
  flattenedZodDetails,
  zodValidationErrorBody,
} from './zodIssues';

// A plain (non-discriminated) union nested two levels deep — the exact shape
// that produced the bare "Invalid input" on the alert-rule write path.
const memberA = z.object({ type: z.literal('a'), value: z.number() });
const memberB = z.object({ type: z.literal('b'), label: z.string(), extra: z.string() });
const nested = z.object({
  items: z.array(z.object({ conditions: z.array(z.union([memberA, memberB])) })),
});

describe('flattenZodIssues', () => {
  it('leaves non-union issues untouched', () => {
    const error = z.object({ n: z.number() }).safeParse({ n: 'x' }).error!;
    const flat = flattenZodIssues(error.issues);
    expect(flat).toHaveLength(1);
    expect(flat[0]!.path).toEqual(['n']);
    expect(flat[0]!.message).toContain('expected number');
  });

  it('replaces an invalid_union with the sub-issues of the nearest-matching option', () => {
    const error = nested.safeParse({ items: [{ conditions: [{ type: 'a', value: 'nope' }] }] }).error!;
    // Zod's own view: one issue, no useful message.
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]!.message).toBe('Invalid input');

    const flat = flattenZodIssues(error.issues);
    // Option A disagrees about ONE field; option B disagrees about three, so A
    // is the better explanation.
    expect(flat).toHaveLength(1);
    expect(flat[0]!.path).toEqual(['items', 0, 'conditions', 0, 'value']);
    expect(flat[0]!.message).toContain('expected number');
  });

  it('re-roots sub-issue paths onto the union path so the reported path is absolute', () => {
    const error = nested.safeParse({ items: [{ conditions: [{ type: 'b', label: 'x' }] }] }).error!;
    const flat = flattenZodIssues(error.issues);
    expect(flat.map((i) => i.path.join('.'))).toContain('items.0.conditions.0.extra');
  });

  it('keeps the discriminator message when a discriminated union matches no option', () => {
    // `errors` is empty in this case, and the issue's own message names every
    // accepted value — strictly more useful than any sub-issue would be.
    const du = z.discriminatedUnion('type', [memberA, memberB]);
    const error = du.safeParse({ type: 'zzz' }).error!;
    const flat = flattenZodIssues(error.issues);
    expect(flat).toHaveLength(1);
    expect(flat[0]!.message).toMatch(/'a'|"a"/);
  });
});

describe('flattenedZodDetails', () => {
  it('keys fieldErrors by the full dotted path, not just the first segment', () => {
    const error = nested.safeParse({ items: [{ conditions: [{ type: 'a', value: 'nope' }] }] }).error!;
    const details = flattenedZodDetails(flattenZodIssues(error.issues));
    expect(Object.keys(details.fieldErrors)).toEqual(['items.0.conditions.0.value']);
    expect(details.formErrors).toEqual([]);
  });

  it('routes path-less issues to formErrors', () => {
    const schema = z.object({ a: z.number() }).refine(() => false, { message: 'whole object is wrong' });
    const details = flattenedZodDetails(flattenZodIssues(schema.safeParse({ a: 1 }).error!.issues));
    expect(details.formErrors).toEqual(['whole object is wrong']);
  });
});

describe('zodValidationErrorBody', () => {
  it('returns error/details/issues all derived from the flattened set', () => {
    const error = nested.safeParse({ items: [{ conditions: [{ type: 'a', value: 'nope' }] }] }).error!;
    const body = zodValidationErrorBody('Invalid alert_rule settings', error);
    expect(body.error).toBe('Invalid alert_rule settings');
    expect(body.issues[0]!.path).toEqual(['items', 0, 'conditions', 0, 'value']);
    expect(JSON.stringify(body.details)).not.toContain('"Invalid input"');
  });
});

describe('describeFirstZodIssue', () => {
  it('prefixes the dotted path onto the most specific message', () => {
    const error = nested.safeParse({ items: [{ conditions: [{ type: 'a', value: 'nope' }] }] }).error!;
    expect(describeFirstZodIssue(error)).toMatch(/^items\.0\.conditions\.0\.value: /);
  });

  it('returns null when there are no issues at all', () => {
    expect(describeFirstZodIssue({ issues: [] })).toBeNull();
  });
});

describe('describeZodIssues', () => {
  // The #3260 case verbatim: the agent sent a null backup result payload and
  // the operator-visible error read "Invalid input: expected object, received
  // null" with no indication of WHAT was null.
  it('labels a root-level failure as <root> instead of dropping the path', () => {
    const error = z.object({ status: z.string() }).safeParse(null).error!;
    const described = describeZodIssues(error);
    expect(described).toContain('<root>');
    expect(described).toContain('expected object, received null');
  });

  it('names the offending field for a nested failure', () => {
    const error = z.object({ result: z.object({ status: z.string() }) }).safeParse({ result: { status: 5 } })
      .error!;
    expect(describeZodIssues(error)).toMatch(/^result\.status: /);
  });

  it('lists every issue, path-qualified', () => {
    const error = z.object({ a: z.string(), b: z.number() }).safeParse({ a: 1, b: 'x' }).error!;
    const described = describeZodIssues(error);
    expect(described).toContain('a: ');
    expect(described).toContain('b: ');
    expect(described).toContain('; ');
  });

  it('unwraps union noise rather than reporting a bare "Invalid input"', () => {
    const error = nested.safeParse({ items: [{ conditions: [{ type: 'a', value: 'nope' }] }] }).error!;
    const described = describeZodIssues(error);
    expect(described).toContain('items.0.conditions.0.value');
    expect(described).not.toBe('<root>: Invalid input');
  });

  it('degrades to a stated placeholder rather than an empty string', () => {
    expect(describeZodIssues({ issues: [] })).toBe('no validation detail available');
  });
});
