// Cron structural validation, shared by the API's `scheduleRegistry.ts`
// (operator env-var cron overrides) and the P2-2 scheduled-sweeps DTOs
// (`AiAgentScheduleDto.cron`). Moved verbatim from
// `apps/api/src/jobs/scheduleRegistry.ts` (P2-2 task 2) so the shared
// validator package can enforce the same structural rule the API's job
// scheduler already relied on — see `scheduleRegistry.ts`'s re-export for
// why this lives in `@breeze/shared` and not just the API.

const CRON_FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (7 == Sunday)
];

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function isValidCronField(field: string, index: number): boolean {
  const [min, max] = CRON_FIELD_RANGES[index]!;
  const names = index === 3 ? MONTH_NAMES : index === 4 ? DAY_NAMES : [];

  const readValue = (token: string): number | null => {
    const named = names.indexOf(token.toLowerCase());
    if (named >= 0) return index === 3 ? named + 1 : named;
    if (!/^\d+$/.test(token)) return null;
    const value = Number(token);
    return value >= min && value <= max ? value : null;
  };

  return field.split(',').every((listItem) => {
    if (listItem === '') return false;
    const [rangePart, stepPart, ...extra] = listItem.split('/');
    if (extra.length > 0) return false;
    if (stepPart !== undefined && !/^[1-9]\d*$/.test(stepPart)) return false;
    if (rangePart === '*') return true;
    const bounds = rangePart!.split('-');
    if (bounds.length > 2) return false;
    const parsed = bounds.map(readValue);
    if (parsed.some((value) => value === null)) return false;
    if (parsed.length === 2 && parsed[0]! > parsed[1]!) return false;
    return true;
  });
}

/**
 * Structural validation of an operator-supplied cron pattern.
 *
 * Deliberately does NOT use `cron-parser` — that is a devDependency, and this
 * module is loaded by the production API. This checks field count and per-field
 * token/range validity, which is what catches the realistic operator mistake
 * (a two-field value such as star-slash-five, which looks fine and is not).
 * `scheduleRegistry.contract.test.ts`
 * cross-checks this function against the real parser over a corpus.
 */
export function isStructurallyValidCron(pattern: string): boolean {
  const fields = pattern.trim().split(/\s+/);
  // 6 fields = the optional leading seconds field BullMQ also accepts.
  if (fields.length !== 5 && fields.length !== 6) return false;
  const fiveFields = fields.length === 6 ? fields.slice(1) : fields;
  if (fields.length === 6 && !isValidCronField(fields[0]!, 0)) return false;
  return fiveFields.every((field, index) => isValidCronField(field, index));
}
