import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Plus, Tag, Trash2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type ScriptTag = {
  id: string;
  name: string;
  color: string;
};

type ScriptItem = {
  id: string;
  name: string;
  tags: string[];
};

type ScriptTagManagerProps = {
  tags?: ScriptTag[];
  scripts?: ScriptItem[];
};

export default function ScriptTagManager({ tags: externalTags, scripts: externalScripts }: ScriptTagManagerProps) {
  const [tags, setTags] = useState<ScriptTag[]>(externalTags ?? []);
  const [scripts, setScripts] = useState<ScriptItem[]>(externalScripts ?? []);
  const [loading, setLoading] = useState(!externalTags && !externalScripts);
  const [error, setError] = useState<string>();
  const [selectedScriptIds, setSelectedScriptIds] = useState<Set<string>>(new Set());
  const [bulkTagIds, setBulkTagIds] = useState<Set<string>>(new Set());
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#22c55e');
  const [tagToDelete, setTagToDelete] = useState<ScriptTag | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const fetchData = useCallback(async () => {
    if (externalTags && externalScripts) return;

    try {
      setLoading(true);
      setError(undefined);

      // Fetch scripts - tags would typically be stored on scripts or in a separate endpoint
      const scriptsResponse = await fetchWithAuth('/scripts?includeSystem=true');
      if (!scriptsResponse.ok) {
        if (scriptsResponse.status === 401) {
          window.location.href = '/login';
          return;
        }
        throw new Error('Failed to fetch scripts');
      }

      const scriptsData = await scriptsResponse.json();
      const scriptList = scriptsData.data ?? scriptsData.scripts ?? (Array.isArray(scriptsData) ? scriptsData : []);

      // Extract unique tags from scripts
      const tagMap = new Map<string, ScriptTag>();
      const scriptItems: ScriptItem[] = [];

      scriptList.forEach((script: { id: string; name: string; tags?: string[] | ScriptTag[]; category?: string }) => {
        const scriptTags: string[] = [];

        if (Array.isArray(script.tags)) {
          script.tags.forEach((tag: string | ScriptTag) => {
            if (typeof tag === 'string') {
              if (!tagMap.has(tag)) {
                tagMap.set(tag, {
                  id: `tag-${tag}`,
                  name: tag,
                  color: getColorForTag(tag)
                });
              }
              scriptTags.push(`tag-${tag}`);
            } else if (tag && typeof tag === 'object' && tag.name) {
              if (!tagMap.has(tag.id)) {
                tagMap.set(tag.id, tag);
              }
              scriptTags.push(tag.id);
            }
          });
        }

        // Use category as a tag if no tags exist
        if (scriptTags.length === 0 && script.category) {
          const categoryTag = `tag-${script.category.toLowerCase()}`;
          if (!tagMap.has(script.category)) {
            tagMap.set(script.category, {
              id: categoryTag,
              name: script.category,
              color: getColorForTag(script.category)
            });
          }
          scriptTags.push(categoryTag);
        }

        scriptItems.push({
          id: script.id,
          name: script.name,
          tags: scriptTags
        });
      });

      setTags(Array.from(tagMap.values()));
      setScripts(scriptItems);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [externalTags, externalScripts]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Generate consistent colors for tags based on name
  function getColorForTag(name: string): string {
    const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length] ?? '#3b82f6';
  }

  const tagUsage = useMemo(() => {
    const usage: Record<string, number> = {};
    scripts.forEach(script => {
      script.tags.forEach(tagId => {
        usage[tagId] = (usage[tagId] || 0) + 1;
      });
    });
    return usage;
  }, [scripts]);

  const toggleScriptSelection = (scriptId: string) => {
    setSelectedScriptIds(prev => {
      const next = new Set(prev);
      if (next.has(scriptId)) {
        next.delete(scriptId);
      } else {
        next.add(scriptId);
      }
      return next;
    });
  };

  const toggleBulkTag = (tagId: string) => {
    setBulkTagIds(prev => {
      const next = new Set(prev);
      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
      }
      return next;
    });
  };

  const handleAddTag = async () => {
    const trimmed = newTagName.trim();
    if (!trimmed) return;
    const duplicate = tags.find(tag => tag.name.toLowerCase() === trimmed.toLowerCase());
    if (duplicate) return;

    setSaving(true);
    try {
      // Note: When a tags API endpoint exists, this would POST to /scripts/tags
      // For now, tags are managed client-side and applied to scripts
      const newTag: ScriptTag = {
        id: `tag-${trimmed.toLowerCase().replace(/\s+/g, '-')}`,
        name: trimmed,
        color: newTagColor
      };
      setTags(prev => [...prev, newTag]);
      setNewTagName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add tag');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteTag = async () => {
    if (!tagToDelete) return;

    setDeleteLoading(true);
    try {
      // Note: When a tags API endpoint exists, this would DELETE /scripts/tags/:id
      // For now, remove tag from local state and update scripts
      setTags(prev => prev.filter(tag => tag.id !== tagToDelete.id));
      setScripts(prev =>
        prev.map(script => ({
          ...script,
          tags: script.tags.filter(tagId => tagId !== tagToDelete.id)
        }))
      );
      setBulkTagIds(prev => {
        const next = new Set(prev);
        next.delete(tagToDelete.id);
        return next;
      });
      setTagToDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete tag');
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleBulkAssign = async () => {
    if (selectedScriptIds.size === 0 || bulkTagIds.size === 0) return;

    setSaving(true);
    try {
      // Update each selected script with the new tags
      // Note: When a proper tags API exists, this would be a batch update
      const selectedTags = Array.from(bulkTagIds);

      for (const scriptId of selectedScriptIds) {
        const script = scripts.find(s => s.id === scriptId);
        if (!script) continue;

        const updatedTags = Array.from(new Set([...script.tags, ...selectedTags]));

        // Convert tag IDs to tag names for API
        const tagNames = updatedTags
          .map(tagId => tags.find(t => t.id === tagId)?.name)
          .filter(Boolean);

        // Update script with new tags
        const response = await fetchWithAuth(`/scripts/${scriptId}`, {
          method: 'PUT',
          body: JSON.stringify({ tags: tagNames })
        });

        if (!response.ok) {
          if (response.status === 401) {
            window.location.href = '/login';
            return;
          }
          // Continue with local update even if API fails
          console.warn(`Failed to update tags for script ${scriptId}`);
        }
      }

      // Update local state
      setScripts(prev =>
        prev.map(script => {
          if (!selectedScriptIds.has(script.id)) return script;
          const combined = new Set([...script.tags, ...selectedTags]);
          return { ...script, tags: Array.from(combined) };
        })
      );
      setBulkTagIds(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign tags');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
            <p className="mt-4 text-sm text-muted-foreground">Loading tags...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error && tags.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
        <button
          type="button"
          onClick={fetchData}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Script Tags</h2>
          <p className="text-sm text-muted-foreground">{tags.length} tags across {scripts.length} scripts</p>
        </div>
        <div className="flex items-center gap-2">
          <Tag className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Manage reusable labels</span>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/20 p-4">
            <h3 className="text-sm font-semibold">All Tags</h3>
            <div className="mt-3 space-y-2">
              {tags.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                  No tags found. Create one below.
                </div>
              ) : (
                tags.map(tag => (
                  <div key={tag.id} className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-3 w-3 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      <div>
                        <p className="text-sm font-medium">{tag.name}</p>
                        <p className="text-xs text-muted-foreground">Used on {tagUsage[tag.id] || 0} scripts</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTagToDelete(tag)}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10"
                      title="Delete tag"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-lg border bg-background p-4">
            <h3 className="text-sm font-semibold">Add New Tag</h3>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
              <input
                value={newTagName}
                onChange={event => setNewTagName(event.target.value)}
                placeholder="Tag name"
                className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={newTagColor}
                  onChange={event => setNewTagColor(event.target.value)}
                  className="h-10 w-12 rounded-md border bg-background"
                />
                <button
                  type="button"
                  onClick={handleAddTag}
                  disabled={saving || !newTagName.trim()}
                  className="flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/20 p-4">
            <h3 className="text-sm font-semibold">Bulk Assign Tags</h3>
            <p className="mt-1 text-xs text-muted-foreground">Select scripts, then choose tags to apply.</p>
            <div className="mt-3 space-y-2 max-h-60 overflow-y-auto">
              {scripts.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                  No scripts found.
                </div>
              ) : (
                scripts.map(script => (
                  <label
                    key={script.id}
                    className={cn(
                      'flex items-center justify-between rounded-md border bg-background px-3 py-2 text-sm cursor-pointer',
                      selectedScriptIds.has(script.id) && 'border-primary/40 bg-primary/5'
                    )}
                  >
                    <span className="truncate">{script.name}</span>
                    <input
                      type="checkbox"
                      checked={selectedScriptIds.has(script.id)}
                      onChange={() => toggleScriptSelection(script.id)}
                      className="h-4 w-4"
                    />
                  </label>
                ))
              )}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {tags.map(tag => (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => toggleBulkTag(tag.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium',
                    bulkTagIds.has(tag.id)
                      ? 'border-primary/50 bg-primary/10 text-primary'
                      : 'border-muted bg-background text-muted-foreground'
                  )}
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tag.color }} />
                  {tag.name}
                  {bulkTagIds.has(tag.id) && <Check className="h-3 w-3" />}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={handleBulkAssign}
              disabled={selectedScriptIds.size === 0 || bulkTagIds.size === 0 || saving}
              className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Apply tags to selected scripts
            </button>
          </div>
        </div>
      </div>

      {tagToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <h3 className="text-lg font-semibold text-red-600">Delete Tag</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Delete the <span className="font-medium">{tagToDelete.name}</span> tag? This will remove it from all scripts.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setTagToDelete(null)}
                disabled={deleteLoading}
                className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteTag}
                disabled={deleteLoading}
                className="inline-flex items-center gap-2 rounded-md bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
              >
                {deleteLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
