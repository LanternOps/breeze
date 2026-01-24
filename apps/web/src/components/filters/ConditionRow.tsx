import { useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import type { FilterCondition, FilterFieldDefinition, FilterOperator, FilterValue } from '@breeze/shared';
import { FieldSelector } from './FieldSelector';
import { OperatorSelector } from './OperatorSelector';
import { ValueInput } from './ValueInput';

interface ConditionRowProps {
  value: FilterCondition;
  onChange: (value: FilterCondition) => void;
  onRemove: () => void;
  filterFields: FilterFieldDefinition[];
  canRemove?: boolean;
}

export function ConditionRow({
  value,
  onChange,
  onRemove,
  filterFields,
  canRemove = true
}: ConditionRowProps) {
  const selectedField = useMemo(() => {
    return filterFields.find(f => f.key === value.field);
  }, [filterFields, value.field]);

  const handleFieldChange = (fieldKey: string) => {
    const field = filterFields.find(f => f.key === fieldKey);
    if (field) {
      // Reset operator and value when field changes
      const defaultOperator = field.operators[0] ?? 'equals';
      onChange({
        field: fieldKey,
        operator: defaultOperator,
        value: getDefaultValue(field.type, defaultOperator)
      });
    }
  };

  const handleOperatorChange = (operator: FilterOperator) => {
    const needsValue = !['isNull', 'isNotNull', 'isEmpty', 'isNotEmpty'].includes(operator);
    onChange({
      ...value,
      operator,
      value: needsValue ? value.value : ''
    });
  };

  const handleValueChange = (newValue: FilterValue) => {
    onChange({ ...value, value: newValue });
  };

  return (
    <div className="flex items-center gap-2 rounded-md border bg-background p-2">
      <FieldSelector
        value={value.field}
        onChange={handleFieldChange}
        fields={filterFields}
      />

      <OperatorSelector
        value={value.operator}
        onChange={handleOperatorChange}
        operators={selectedField?.operators || []}
        fieldType={selectedField?.type || 'string'}
      />

      <div className="flex-1">
        <ValueInput
          value={value.value}
          onChange={handleValueChange}
          field={selectedField}
          operator={value.operator}
        />
      </div>

      <button
        type="button"
        onClick={onRemove}
        disabled={!canRemove}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-destructive disabled:opacity-40 disabled:cursor-not-allowed"
        title="Remove condition"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function getDefaultValue(type: string, operator: FilterOperator): FilterValue {
  if (['isNull', 'isNotNull', 'isEmpty', 'isNotEmpty'].includes(operator)) {
    return '';
  }

  if (operator === 'withinLast' || operator === 'notWithinLast') {
    return { amount: 7, unit: 'days' };
  }

  if (operator === 'between') {
    return { from: new Date(), to: new Date() };
  }

  if (operator === 'in' || operator === 'notIn' || operator === 'hasAny' || operator === 'hasAll') {
    return [];
  }

  switch (type) {
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'date':
    case 'datetime':
      return new Date().toISOString();
    default:
      return '';
  }
}

export default ConditionRow;
