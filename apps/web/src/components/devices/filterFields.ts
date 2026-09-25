// Field catalog for the v2 chip-based filter UI.
//
// The chip bar uses the SAME canonical device filter catalog as the rest of the
// app (../filters/filterFields, which mirrors the backend filterEngine), not a
// separate hand-maintained copy. This file keeps only the chip-bar-specific
// label helpers.
import type { FilterFieldDefinition, FilterOperator } from '@breeze/shared';
import { FILTER_FIELDS } from '../filters/filterFields';
import type { CustomFieldDefinition } from '../../stores/customFieldDefinitions';

export const V2_FILTER_FIELDS: FilterFieldDefinition[] = FILTER_FIELDS;

// The backend's filterEngine.getFieldDefinition() synthesizes every
// `custom.<key>` field as { type: 'string', operators: <string operator set> }
// regardless of the custom field's own declared type (filterEngine.ts:141-152)
// — validateFilter enforces exactly that operator set server-side. Mirroring
// it here (rather than mapping the definition's real type) keeps every
// operator the picker offers backend-valid; widening this would let the UI
// offer e.g. `greaterThan` on a custom field and have the server 400 it.
const CUSTOM_FIELD_OPERATORS: FilterOperator[] = [
  'equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith',
  'matches', 'in', 'notIn', 'isNull', 'isNotNull'
];

export function customFieldToFilterField(def: CustomFieldDefinition): FilterFieldDefinition {
  return {
    key: `custom.${def.fieldKey}`,
    label: def.name,
    category: 'custom',
    type: 'string',
    operators: CUSTOM_FIELD_OPERATORS
  };
}

// Live cache of custom-field-derived filter fields, populated by
// useSyncCustomFilterFields() (customFilterFieldsSync.ts) once
// GET /custom-fields resolves. getFieldDef/getAllFilterFields read it
// synchronously so any component that merely renders (rather than triggers
// the fetch) still resolves a field/label correctly once a fetching
// ancestor has re-rendered the tree.
let customFilterFieldsCache: FilterFieldDefinition[] = [];

export function setCustomFilterFields(fields: FilterFieldDefinition[]): void {
  customFilterFieldsCache = fields;
}

// Every static field plus whatever custom field definitions are currently
// cached (issue #6594) — the single list the advanced filter's field picker,
// the "+ Add filter" dropdown, and the sentence-builder's field select all
// draw from.
export function getAllFilterFields(): FilterFieldDefinition[] {
  return customFilterFieldsCache.length > 0
    ? [...V2_FILTER_FIELDS, ...customFilterFieldsCache]
    : V2_FILTER_FIELDS;
}

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
  return V2_FILTER_FIELDS.find(f => f.key === key)
    ?? customFilterFieldsCache.find(f => f.key === key);
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
