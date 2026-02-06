import type { FilterCondition, FilterConditionGroup } from '@breeze/shared';

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
