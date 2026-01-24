import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, Search, Settings, ChevronDown, AlertCircle } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import type { CustomFieldDefinition, CustomFieldType, CustomFieldOptions } from '@breeze/shared';

interface CustomField extends Omit<CustomFieldDefinition, 'createdAt' | 'updatedAt'> {
  createdAt: string | Date;
  updatedAt: string | Date;
}

type ModalMode = 'closed' | 'create' | 'edit' | 'delete';

const FIELD_TYPES: Array<{ value: CustomFieldType; label: string; description: string }> = [
  { value: 'text', label: 'Text', description: 'Single or multi-line text input' },
  { value: 'number', label: 'Number', description: 'Numeric value with optional min/max' },
  { value: 'boolean', label: 'Yes/No', description: 'Toggle or checkbox field' },
  { value: 'dropdown', label: 'Dropdown', description: 'Select from predefined options' },
  { value: 'date', label: 'Date', description: 'Date picker input' }
];

const DEVICE_TYPE_OPTIONS = [
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' }
];

export default function CustomFieldsPage() {
  const [fields, setFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<CustomFieldType | ''>('');

  // Modal state
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedField, setSelectedField] = useState<CustomField | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formFieldKey, setFormFieldKey] = useState('');
  const [formType, setFormType] = useState<CustomFieldType>('text');
  const [formRequired, setFormRequired] = useState(false);
  const [formDefaultValue, setFormDefaultValue] = useState<unknown>(null);
  const [formDeviceTypes, setFormDeviceTypes] = useState<string[]>([]);
  const [formOptions, setFormOptions] = useState<CustomFieldOptions>({});
  const [dropdownChoices, setDropdownChoices] = useState<Array<{ label: string; value: string }>>([]);

  const fetchFields = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (typeFilter) params.set('type', typeFilter);
      if (searchQuery) params.set('search', searchQuery);

      const response = await fetchWithAuth(`/custom-fields?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to fetch custom fields');
      }
      const data = await response.json();
      setFields(data.data ?? data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch custom fields');
    } finally {
      setLoading(false);
    }
  }, [typeFilter, searchQuery]);

  useEffect(() => {
    fetchFields();
  }, [fetchFields]);

  const filteredFields = fields.filter((field) => {
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      if (
        !field.name.toLowerCase().includes(query) &&
        !field.fieldKey.toLowerCase().includes(query)
      ) {
        return false;
      }
    }
    if (typeFilter && field.type !== typeFilter) {
      return false;
    }
    return true;
  });

  const resetForm = () => {
    setFormName('');
    setFormFieldKey('');
    setFormType('text');
    setFormRequired(false);
    setFormDefaultValue(null);
    setFormDeviceTypes([]);
    setFormOptions({});
    setDropdownChoices([]);
    setFormError(null);
  };

  const handleOpenCreate = () => {
    resetForm();
    setSelectedField(null);
    setModalMode('create');
  };

  const handleOpenEdit = (field: CustomField) => {
    setSelectedField(field);
    setFormName(field.name);
    setFormFieldKey(field.fieldKey);
    setFormType(field.type as CustomFieldType);
    setFormRequired(field.required);
    setFormDefaultValue(field.defaultValue);
    setFormDeviceTypes(field.deviceTypes ?? []);
    setFormOptions((field.options as CustomFieldOptions) ?? {});
    setDropdownChoices(
      (field.options as CustomFieldOptions)?.choices ?? []
    );
    setFormError(null);
    setModalMode('edit');
  };

  const handleOpenDelete = (field: CustomField) => {
    setSelectedField(field);
    setModalMode('delete');
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedField(null);
    resetForm();
  };

  const generateFieldKey = (name: string): string => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
  };

  const handleNameChange = (name: string) => {
    setFormName(name);
    if (modalMode === 'create') {
      setFormFieldKey(generateFieldKey(name));
    }
  };

  const handleAddDropdownChoice = () => {
    setDropdownChoices([...dropdownChoices, { label: '', value: '' }]);
  };

  const handleRemoveDropdownChoice = (index: number) => {
    setDropdownChoices(dropdownChoices.filter((_, i) => i !== index));
  };

  const handleDropdownChoiceChange = (
    index: number,
    field: 'label' | 'value',
    newValue: string
  ) => {
    const updated = [...dropdownChoices];
    const current = updated[index];
    updated[index] = {
      label: current?.label ?? '',
      value: current?.value ?? '',
      [field]: newValue
    };
    // Auto-generate value from label if value is empty
    if (field === 'label' && !updated[index].value) {
      updated[index].value = generateFieldKey(newValue);
    }
    setDropdownChoices(updated);
  };

  const handleToggleDeviceType = (deviceType: string) => {
    setFormDeviceTypes((prev) =>
      prev.includes(deviceType)
        ? prev.filter((t) => t !== deviceType)
        : [...prev, deviceType]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedName = formName.trim();
    const trimmedKey = formFieldKey.trim();

    if (!trimmedName) {
      setFormError('Name is required');
      return;
    }

    if (!trimmedKey) {
      setFormError('Field key is required');
      return;
    }

    if (!/^[a-z][a-z0-9_]*$/.test(trimmedKey)) {
      setFormError('Field key must start with a letter and contain only lowercase letters, numbers, and underscores');
      return;
    }

    if (formType === 'dropdown' && dropdownChoices.length < 2) {
      setFormError('Dropdown fields need at least 2 choices');
      return;
    }

    setSubmitting(true);
    setFormError(null);

    try {
      const options: CustomFieldOptions = {};
      if (formType === 'dropdown') {
        options.choices = dropdownChoices.filter((c) => c.label && c.value);
      }
      if (formType === 'number') {
        if (formOptions.min !== undefined) options.min = formOptions.min;
        if (formOptions.max !== undefined) options.max = formOptions.max;
      }
      if (formType === 'text') {
        if (formOptions.minLength !== undefined) options.minLength = formOptions.minLength;
        if (formOptions.maxLength !== undefined) options.maxLength = formOptions.maxLength;
        if (formOptions.pattern) options.pattern = formOptions.pattern;
      }

      const payload = {
        name: trimmedName,
        fieldKey: trimmedKey,
        type: formType,
        required: formRequired,
        defaultValue: formDefaultValue,
        deviceTypes: formDeviceTypes.length > 0 ? formDeviceTypes : null,
        options: Object.keys(options).length > 0 ? options : null
      };

      const url = modalMode === 'edit' && selectedField
        ? `/custom-fields/${selectedField.id}`
        : '/custom-fields';
      const method = modalMode === 'edit' ? 'PATCH' : 'POST';

      const response = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to save custom field');
      }

      await fetchFields();
      handleCloseModal();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save custom field');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedField) return;

    setSubmitting(true);
    setFormError(null);

    try {
      const response = await fetchWithAuth(`/custom-fields/${selectedField.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete custom field');
      }

      await fetchFields();
      handleCloseModal();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to delete custom field');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Custom Fields</h1>
          <p className="text-muted-foreground">
            Define custom attributes to track additional information on devices.
          </p>
        </div>
        <button
          type="button"
          onClick={handleOpenCreate}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Add Custom Field
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search fields..."
            className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as CustomFieldType | '')}
          className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">All Types</option>
          {FIELD_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
      </div>

      {filteredFields.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center">
          <Settings className="mx-auto h-12 w-12 text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">
            {searchQuery || typeFilter
              ? 'No custom fields match your filters'
              : 'No custom fields defined yet. Add one to start tracking custom device attributes.'}
          </p>
          {!searchQuery && !typeFilter && (
            <button
              type="button"
              onClick={handleOpenCreate}
              className="mt-4 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              <Plus className="h-4 w-4" />
              Add your first custom field
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-lg border bg-card">
          <table className="w-full">
            <thead className="border-b bg-muted/40">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium">Name</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Key</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Type</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Required</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Device Types</th>
                <th className="px-4 py-3 text-right text-sm font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredFields.map((field) => (
                <tr key={field.id} className="hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <div className="font-medium">{field.name}</div>
                  </td>
                  <td className="px-4 py-3">
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {field.fieldKey}
                    </code>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full border px-2 py-0.5 text-xs capitalize">
                      {field.type}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        field.required
                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {field.required ? 'Required' : 'Optional'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {field.deviceTypes && field.deviceTypes.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {field.deviceTypes.map((dt) => (
                          <span
                            key={dt}
                            className="rounded bg-muted px-1.5 py-0.5 text-xs capitalize"
                          >
                            {dt}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">All</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => handleOpenEdit(field)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpenDelete(field)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit Modal */}
      {(modalMode === 'create' || modalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8 overflow-y-auto">
          <div className="w-full max-w-2xl my-8 rounded-lg border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">
              {modalMode === 'create' ? 'Add Custom Field' : 'Edit Custom Field'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {modalMode === 'create'
                ? 'Define a new custom attribute for devices.'
                : 'Update the custom field configuration.'}
            </p>

            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-sm font-medium">Display Name</label>
                  <input
                    type="text"
                    value={formName}
                    onChange={(e) => handleNameChange(e.target.value)}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="e.g., Asset Tag"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Field Key</label>
                  <input
                    type="text"
                    value={formFieldKey}
                    onChange={(e) => setFormFieldKey(e.target.value)}
                    disabled={modalMode === 'edit'}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
                    placeholder="e.g., asset_tag"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Used in filters and API. Cannot be changed after creation.
                  </p>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium">Field Type</label>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {FIELD_TYPES.map((type) => (
                    <button
                      key={type.value}
                      type="button"
                      onClick={() => {
                        setFormType(type.value);
                        setFormDefaultValue(null);
                        setFormOptions({});
                        setDropdownChoices([]);
                      }}
                      disabled={modalMode === 'edit'}
                      className={`rounded-md border p-3 text-left transition disabled:opacity-60 ${
                        formType === type.value
                          ? 'border-primary bg-primary/10'
                          : 'hover:bg-muted'
                      }`}
                    >
                      <div className="font-medium text-sm">{type.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {type.description}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Type-specific options */}
              {formType === 'dropdown' && (
                <div>
                  <label className="text-sm font-medium">Dropdown Choices</label>
                  <div className="mt-2 space-y-2">
                    {dropdownChoices.map((choice, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={choice.label}
                          onChange={(e) =>
                            handleDropdownChoiceChange(index, 'label', e.target.value)
                          }
                          placeholder="Label"
                          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                        <input
                          type="text"
                          value={choice.value}
                          onChange={(e) =>
                            handleDropdownChoiceChange(index, 'value', e.target.value)
                          }
                          placeholder="Value"
                          className="h-9 w-32 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                        <button
                          type="button"
                          onClick={() => handleRemoveDropdownChoice(index)}
                          className="h-9 w-9 rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4 mx-auto" />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={handleAddDropdownChoice}
                      className="inline-flex h-9 items-center gap-1 rounded-md border px-3 text-sm font-medium hover:bg-muted"
                    >
                      <Plus className="h-4 w-4" />
                      Add Choice
                    </button>
                  </div>
                </div>
              )}

              {formType === 'number' && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="text-sm font-medium">Minimum Value (optional)</label>
                    <input
                      type="number"
                      value={formOptions.min ?? ''}
                      onChange={(e) =>
                        setFormOptions({
                          ...formOptions,
                          min: e.target.value ? Number(e.target.value) : undefined
                        })
                      }
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Maximum Value (optional)</label>
                    <input
                      type="number"
                      value={formOptions.max ?? ''}
                      onChange={(e) =>
                        setFormOptions({
                          ...formOptions,
                          max: e.target.value ? Number(e.target.value) : undefined
                        })
                      }
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
              )}

              {formType === 'text' && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="text-sm font-medium">Max Length (optional)</label>
                    <input
                      type="number"
                      value={formOptions.maxLength ?? ''}
                      onChange={(e) =>
                        setFormOptions({
                          ...formOptions,
                          maxLength: e.target.value ? Number(e.target.value) : undefined
                        })
                      }
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Pattern (regex, optional)</label>
                    <input
                      type="text"
                      value={formOptions.pattern ?? ''}
                      onChange={(e) =>
                        setFormOptions({
                          ...formOptions,
                          pattern: e.target.value || undefined
                        })
                      }
                      placeholder="e.g., ^[A-Z]{2}-\\d{4}$"
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="text-sm font-medium">Device Types (optional)</label>
                <p className="text-xs text-muted-foreground">
                  Leave empty to show on all device types
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {DEVICE_TYPE_OPTIONS.map((dt) => (
                    <label
                      key={dt.value}
                      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm cursor-pointer transition ${
                        formDeviceTypes.includes(dt.value)
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'hover:bg-muted'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={formDeviceTypes.includes(dt.value)}
                        onChange={() => handleToggleDeviceType(dt.value)}
                        className="sr-only"
                      />
                      {dt.label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="required"
                  checked={formRequired}
                  onChange={(e) => setFormRequired(e.target.checked)}
                  className="h-4 w-4 rounded border-muted"
                />
                <label htmlFor="required" className="text-sm font-medium">
                  Required field
                </label>
              </div>

              {formError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {formError}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleCloseModal}
                  className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
                >
                  {submitting
                    ? 'Saving...'
                    : modalMode === 'create'
                      ? 'Create Field'
                      : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedField && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">Delete Custom Field</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete{' '}
              <span className="font-medium text-foreground">{selectedField.name}</span>?
              This will remove the field definition and all stored values on devices.
            </p>

            {formError && (
              <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {formError}
              </div>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={submitting}
                className="h-10 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-60"
              >
                {submitting ? 'Deleting...' : 'Delete Field'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
