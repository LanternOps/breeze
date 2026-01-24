import type { FilterOperator, FilterFieldType } from '@breeze/shared';

interface OperatorSelectorProps {
  value: FilterOperator;
  onChange: (operator: FilterOperator) => void;
  operators: FilterOperator[];
  fieldType: FilterFieldType;
  className?: string;
}

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  // Comparison
  equals: 'equals',
  notEquals: 'does not equal',
  greaterThan: 'greater than',
  greaterThanOrEquals: 'greater than or equals',
  lessThan: 'less than',
  lessThanOrEquals: 'less than or equals',
  // String
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  matches: 'matches regex',
  // Collection
  in: 'is one of',
  notIn: 'is not one of',
  hasAny: 'has any of',
  hasAll: 'has all of',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
  // Null
  isNull: 'is empty',
  isNotNull: 'is not empty',
  // Date
  before: 'is before',
  after: 'is after',
  between: 'is between',
  withinLast: 'within last',
  notWithinLast: 'not within last'
};

// Shorter labels for compact display
const SHORT_LABELS: Partial<Record<FilterOperator, string>> = {
  greaterThan: '>',
  greaterThanOrEquals: '>=',
  lessThan: '<',
  lessThanOrEquals: '<=',
  equals: '=',
  notEquals: '!=',
  contains: 'contains',
  notContains: '!contains'
};

export function OperatorSelector({
  value,
  onChange,
  operators,
  fieldType,
  className = ''
}: OperatorSelectorProps) {
  // Filter operators based on field type for better UX
  const availableOperators = operators.filter(op => {
    // Hide operators that don't make sense for certain types
    if (fieldType === 'boolean') {
      return ['equals', 'notEquals'].includes(op);
    }
    return true;
  });

  if (availableOperators.length === 0) {
    return null;
  }

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as FilterOperator)}
      className={`h-9 min-w-[140px] rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${className}`}
    >
      {availableOperators.map((operator) => (
        <option key={operator} value={operator}>
          {OPERATOR_LABELS[operator] || operator}
        </option>
      ))}
    </select>
  );
}

export default OperatorSelector;
export { OPERATOR_LABELS, SHORT_LABELS };
