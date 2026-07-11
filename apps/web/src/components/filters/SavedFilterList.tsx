import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, Copy, Search, Filter, MoreVertical } from 'lucide-react';
import type { SavedFilter, FilterConditionGroup } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { FilterBuilder } from './FilterBuilder';
import { useTranslation } from 'react-i18next';

interface SavedFilterListProps {
  onSelectFilter?: (filter: SavedFilter) => void;
  onApplyFilter?: (conditions: FilterConditionGroup) => void;
  className?: string;
  timezone?: string;
}

export function SavedFilterList({
  onSelectFilter,
  onApplyFilter,
  className = '',
  timezone
}: SavedFilterListProps) {
  const { t } = useTranslation('common');
  const [filters, setFilters] = useState<SavedFilter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [editingFilter, setEditingFilter] = useState<SavedFilter | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formConditions, setFormConditions] = useState<FilterConditionGroup>({
    operator: 'AND',
    conditions: [{ field: 'hostname', operator: 'contains', value: '' }]
  });
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const fetchFilters = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetchWithAuth('/filters');
      if (!response.ok) {
        throw new Error('Failed to fetch saved filters');
      }
      const data = await response.json();
      setFilters(data.data ?? data.filters ?? data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch filters');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFilters();
  }, [fetchFilters]);

  const filteredFilters = searchQuery
    ? filters.filter(
        (f) =>
          f.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          f.description?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : filters;

  const resetForm = () => {
    setFormName('');
    setFormDescription('');
    setFormConditions({
      operator: 'AND',
      conditions: [{ field: 'hostname', operator: 'contains', value: '' }]
    });
    setFormError(null);
  };

  const handleCreate = () => {
    resetForm();
    setEditingFilter(null);
    setIsCreating(true);
  };

  const handleEdit = (filter: SavedFilter) => {
    setFormName(filter.name);
    setFormDescription(filter.description || '');
    setFormConditions(filter.conditions);
    setFormError(null);
    setEditingFilter(filter);
    setIsCreating(true);
  };

  const handleDuplicate = (filter: SavedFilter) => {
    setFormName(`${filter.name} (Copy)`);
    setFormDescription(filter.description || '');
    setFormConditions(filter.conditions);
    setFormError(null);
    setEditingFilter(null);
    setIsCreating(true);
  };

  const handleCancel = () => {
    setIsCreating(false);
    setEditingFilter(null);
    resetForm();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = formName.trim();
    if (!trimmedName) {
      setFormError(t('filters.saved.nameRequired'));
      return;
    }

    setFormSubmitting(true);
    setFormError(null);

    try {
      const url = editingFilter ? `/filters/${editingFilter.id}` : '/filters';
      const method = editingFilter ? 'PATCH' : 'POST';

      const response = await fetchWithAuth(url, {
        method,
        body: JSON.stringify({
          name: trimmedName,
          description: formDescription.trim() || null,
          conditions: formConditions
        })
      });

      if (!response.ok) {
        throw new Error('Failed to save filter');
      }

      await fetchFilters();
      handleCancel();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save filter');
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const response = await fetchWithAuth(`/filters/${id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete filter');
      }

      await fetchFilters();
      setDeleteConfirmId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete filter');
    }
  };

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-12 ${className}`}>
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (isCreating) {
    return (
      <div className={`space-y-6 ${className}`}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {editingFilter ? t('filters.saved.edit') : t('filters.saved.create')}
          </h2>
          <button
            type="button"
            onClick={handleCancel}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {t('actions.cancel')}
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-sm font-medium">{t('labels.name')}</label>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              placeholder={t('filters.saved.namePlaceholder')}
            />
          </div>

          <div>
            <label className="text-sm font-medium">{t('filters.saved.description')}</label>
            <textarea
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              className="mt-1 u-min-h-px-80 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              placeholder={t('filters.saved.descriptionPlaceholder')}
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block">{t('filters.saved.conditions')}</label>
            <FilterBuilder
              value={formConditions}
              onChange={setFormConditions}
              showPreview={true}
            />
          </div>

          {formError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {formError}
            </div>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={handleCancel}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
            {t('actions.cancel')}
            </button>
            <button
              type="submit"
              disabled={formSubmitting}
              className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {formSubmitting
                ? t('states.saving')
                : editingFilter
                  ? t('filters.saved.saveChanges')
                  : t('filters.saved.create')}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Filter className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">{t('filters.saved.title')}</h2>
        </div>
        <button
          type="button"
          onClick={handleCreate}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
            {t('filters.saved.new')}
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('filters.saved.search')}
          className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {filteredFilters.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-center">
          <Filter className="mx-auto h-10 w-10 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">
            {searchQuery
              ? t('filters.saved.noMatches')
              : t('filters.saved.empty')}
          </p>
          {!searchQuery && (
            <button
              type="button"
              onClick={handleCreate}
              className="mt-4 inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              <Plus className="h-4 w-4" />
              {t('filters.saved.createFirst')}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredFilters.map((filter) => (
            <div
              key={filter.id}
              className="rounded-lg border bg-card p-4 hover:bg-muted/20 transition"
            >
              <div className="flex items-start justify-between">
                <div
                  className="flex-1 cursor-pointer"
                  onClick={() => {
                    onSelectFilter?.(filter);
                    onApplyFilter?.(filter.conditions);
                  }}
                >
                  <h3 className="font-medium">{filter.name}</h3>
                  {filter.description && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {filter.description}
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>
                      {t('filters.conditionCount', { count: filter.conditions.conditions.length })}
                    </span>
                    <span>·</span>
                    <span>
                      {t('filters.saved.created', {
                        date: new Date(filter.createdAt).toLocaleDateString([], { timeZone: timezone }),
                      })}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleEdit(filter)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                    title={t('actions.edit')}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDuplicate(filter)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                    title={t('filters.saved.duplicate')}
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirmId(filter.id)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                    title={t('actions.delete')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {deleteConfirmId === filter.id && (
                <div className="mt-3 flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
                  <span className="text-sm text-destructive">
                    {t('filters.saved.deleteConfirm')}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmId(null)}
                      className="h-7 rounded border px-2 text-xs font-medium hover:bg-muted"
                    >
                      {t('actions.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(filter.id)}
                      className="h-7 rounded bg-destructive px-2 text-xs font-medium text-destructive-foreground hover:opacity-90"
                    >
                      {t('actions.delete')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default SavedFilterList;
