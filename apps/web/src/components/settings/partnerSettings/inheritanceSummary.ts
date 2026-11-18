import type { InheritanceTabDto } from '@breeze/shared';
import type { InheritanceBucket } from '@/lib/api/partnerSettingsInheritance';
import { inheritanceLineCopy, type LineClause } from './inheritanceLineCopy';

export type DifferingField = { fieldId: string; clause: LineClause & { drill: InheritanceBucket } };

export type TabSummary = {
  /** Fields whose partner value locks orgs right now (set and in force). */
  locks: number;
  /** Fields an org can override. */
  overridable: number;
  /** Fields where at least one org differs from the partner default, with the count that says how. */
  differing: DifferingField[];
};

/**
 * The side panel's tab summary (spec §5.5). "Differs" is per setting: the
 * read model counts orgs per field, not distinct orgs across fields, so the
 * summary never adds field counts together.
 */
export function summarizeTab(data: InheritanceTabDto): TabSummary {
  let locks = 0;
  let overridable = 0;
  const differing: DifferingField[] = [];
  for (const field of data.fields) {
    if (field.kind === 'locks' && field.partnerSet && field.inForce) locks += 1;
    if (field.kind === 'overridable') overridable += 1;
    const copy = inheritanceLineCopy(field, data.orgCount, { draftDirty: false, platformDefaultLabel: null });
    const clause = copy.clauses.find((c): c is DifferingField['clause'] => !!c.drill);
    if (clause) differing.push({ fieldId: field.id, clause });
  }
  return { locks, overridable, differing };
}
