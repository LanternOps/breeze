// Field catalog for the v2 chip-based filter UI.
//
// The chip bar uses the SAME canonical device filter catalog as the rest of the
// app (../filters/filterFields, which mirrors the backend filterEngine), not a
// separate hand-maintained copy. This file keeps only the chip-bar-specific
// label helpers.
import type { FilterFieldDefinition, FilterOperator } from '@breeze/shared';
import { FILTER_FIELDS } from '../filters/filterFields';

export const V2_FILTER_FIELDS: FilterFieldDefinition[] = FILTER_FIELDS;

const CATEGORY_LABEL: Record<string, string> = {
  core: 'Core',
  os: 'OS',
  hardware: 'Hardware',
  network: 'Network',
  metrics: 'Metrics',
  software: 'Software',
  hierarchy: 'Hierarchy',
  computed: 'Computed',
  custom: 'Custom Fields'
};

export function fieldCategoryLabel(category: string): string {
  return CATEGORY_LABEL[category] ?? category;
}

export function getFieldDef(key: string): FilterFieldDefinition | undefined {
  return V2_FILTER_FIELDS.find(f => f.key === key);
}

const OPERATOR_LABEL: Record<FilterOperator, string> = {
  equals: 'is',
  notEquals: 'is not',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  matches: 'matches regex',
  greaterThan: '>',
  greaterThanOrEquals: '>=',
  lessThan: '<',
  lessThanOrEquals: '<=',
  in: 'is any of',
  notIn: 'is none of',
  hasAny: 'has any of',
  hasAll: 'has all of',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
  isNull: 'is null',
  isNotNull: 'is not null',
  before: 'before',
  after: 'after',
  between: 'between',
  withinLast: 'within last',
  notWithinLast: 'not within last'
};

export function operatorLabel(op: FilterOperator): string {
  return OPERATOR_LABEL[op] ?? op;
}
