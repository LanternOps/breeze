import type { FilterCondition, FilterConditionGroup, FilterOperator } from '@breeze/shared';
import { FILTER_FIELDS } from '../filters/filterFields';
import { OPERATOR_LABELS } from '../filters/OperatorSelector';

interface LegacyDeviceGroupRule {
  id: string;
  field: 'os' | 'site' | 'tag' | 'hostname';
  operator: 'is' | 'is_not' | 'contains' | 'not_contains' | 'matches' | 'not_matches';
  value: string;
}

const FIELD_MAP: Record<string, string> = {
  os: 'osType',
  site: 'siteId',
  tag: 'tags',
  hostname: 'hostname'
};

const OPERATOR_MAP: Record<string, Record<string, string>> = {
  os: { is: 'equals', is_not: 'notEquals' },
  site: { is: 'equals', is_not: 'notEquals' },
  tag: { contains: 'hasAny', not_contains: 'hasAny' },
  hostname: {
    contains: 'contains',
    not_contains: 'notContains',
    matches: 'matches',
    not_matches: 'matches'
  }
};

export function legacyRulesToFilterConditions(rules: LegacyDeviceGroupRule[]): FilterConditionGroup {
  if (rules.length === 0) {
    return {
      operator: 'AND',
      conditions: [{ field: 'hostname', operator: 'contains', value: '' }]
    };
  }

  const conditions: FilterCondition[] = rules.map(rule => {
    const field = FIELD_MAP[rule.field] ?? rule.field;
    const operatorMapping = OPERATOR_MAP[rule.field] ?? {};
    const operator = (operatorMapping[rule.operator] ?? 'equals') as FilterCondition['operator'];

    let value: FilterCondition['value'] = rule.value;

    // Tags use hasAny which expects an array
    if (rule.field === 'tag') {
      value = [rule.value];
    }

    return { field, operator, value };
  });

  return { operator: 'AND', conditions };
}

const FIELD_LABELS = new Map(FILTER_FIELDS.map(field => [field.key, field.label]));

export const NO_VALUE_OPERATORS: FilterOperator[] = ['isNull', 'isNotNull', 'isEmpty', 'isNotEmpty'];

function isConditionGroup(entry: FilterCondition | FilterConditionGroup): entry is FilterConditionGroup {
  return entry !== null && typeof entry === 'object' && Array.isArray((entry as FilterConditionGroup).conditions);
}

function formatFilterValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(item => formatFilterValue(item)).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('amount' in record && 'unit' in record) return `${record.amount} ${record.unit}`;
    if ('from' in record && 'to' in record) return `${formatFilterValue(record.from)} - ${formatFilterValue(record.to)}`;
    return '';
  }
  return String(value);
}

function describeEntry(entry: FilterCondition | FilterConditionGroup): string {
  if (isConditionGroup(entry)) {
    const inner = entry.conditions.map(describeEntry).filter(Boolean);
    if (inner.length === 0) return '';
    return `(${inner.join(entry.operator === 'OR' ? ' OR ' : ' AND ')})`;
  }

  const fieldLabel = FIELD_LABELS.get(entry.field) ?? entry.field;
  const operatorLabel = OPERATOR_LABELS[entry.operator] ?? entry.operator;
  if (NO_VALUE_OPERATORS.includes(entry.operator)) return `${fieldLabel} ${operatorLabel}`;

  const value = formatFilterValue(entry.value);
  return value ? `${fieldLabel} ${operatorLabel} ${value}` : '';
}

/**
 * Human-readable chips for a `filterConditions` tree, using the same field and
 * operator vocabulary the FilterBuilder shows.
 *
 * This is the honest counterpart to `filterConditionsToLegacyRules`: the legacy
 * rule vocabulary covers four fields, the filter vocabulary covers forty, so
 * round-tripping a real filter through legacy rules for DISPLAY silently
 * relabels most conditions as "Hostname contains …". Describe the filter
 * directly instead.
 */
export function describeFilterConditions(
  conditions: FilterConditionGroup | null | undefined
): string[] {
  if (!conditions || !Array.isArray(conditions.conditions)) return [];
  const parts = conditions.conditions.map(describeEntry).filter(Boolean);
  // A top-level OR must not render as a list of chips — the card reads those
  // as ANDed. Collapse it into one chip that states the operator.
  if (conditions.operator === 'OR' && parts.length > 1) return [parts.join(' OR ')];
  return parts;
}

export function filterConditionsToLegacyRules(
  conditions: FilterConditionGroup
): LegacyDeviceGroupRule[] {
  // Best-effort reverse conversion for backward compatibility
  let idCounter = 0;
  const rules: LegacyDeviceGroupRule[] = [];

  for (const c of conditions.conditions) {
    if ('conditions' in c) continue; // Skip nested groups

    idCounter++;
    const condition = c as FilterCondition;

    let field: LegacyDeviceGroupRule['field'] = 'hostname';
    let operator: LegacyDeviceGroupRule['operator'] = 'contains';
    let value = String(condition.value ?? '');

    if (condition.field === 'osType') {
      field = 'os';
      operator = condition.operator === 'notEquals' ? 'is_not' : 'is';
    } else if (condition.field === 'siteId') {
      field = 'site';
      operator = condition.operator === 'notEquals' ? 'is_not' : 'is';
    } else if (condition.field === 'tags') {
      field = 'tag';
      operator = 'contains';
      value = Array.isArray(condition.value) ? String(condition.value[0] ?? '') : value;
    } else if (condition.field === 'hostname') {
      field = 'hostname';
      if (condition.operator === 'contains') operator = 'contains';
      else if (condition.operator === 'notContains') operator = 'not_contains';
      else if (condition.operator === 'matches') operator = 'matches';
      else operator = 'contains';
    }

    rules.push({ id: `migrated-${idCounter}`, field, operator, value });
  }

  return rules;
}
