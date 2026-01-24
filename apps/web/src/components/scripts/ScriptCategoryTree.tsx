import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  Folder,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type ScriptCategory = {
  id: string;
  name: string;
  children?: ScriptCategory[];
};

type ScriptItem = {
  id: string;
  name: string;
  categoryId: string;
  status: 'active' | 'draft' | 'archived';
};

type ScriptCategoryTreeProps = {
  categories?: ScriptCategory[];
  scripts?: ScriptItem[];
  onSelectCategory?: (categoryId: string | null) => void;
};

type ContextMenuState = {
  x: number;
  y: number;
  categoryId: string;
} | null;

const statusStyles: Record<ScriptItem['status'], string> = {
  active: 'bg-green-500/15 text-green-700',
  draft: 'bg-yellow-500/15 text-yellow-700',
  archived: 'bg-gray-500/15 text-gray-700'
};

let idCounter = 0;
const createId = (prefix: string = 'cat') => {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
};

const findCategory = (nodes: ScriptCategory[], id: string): ScriptCategory | undefined => {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findCategory(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
};

const findCategoryName = (nodes: ScriptCategory[], id: string): string | undefined => {
  return findCategory(nodes, id)?.name;
};

const collectDescendantIds = (nodes: ScriptCategory[], id: string): string[] => {
  for (const node of nodes) {
    if (node.id === id) {
      const gather = (children?: ScriptCategory[]): string[] => {
        if (!children) return [];
        return children.flatMap(child => [child.id, ...gather(child.children)]);
      };
      return gather(node.children);
    }
    if (node.children) {
      const found = collectDescendantIds(node.children, id);
      if (found.length) return found;
    }
  }
  return [];
};

const updateCategoryName = (nodes: ScriptCategory[], id: string, name: string): ScriptCategory[] => {
  return nodes.map(node => {
    if (node.id === id) {
      return { ...node, name };
    }
    if (node.children) {
      return { ...node, children: updateCategoryName(node.children, id, name) };
    }
    return node;
  });
};

const addSubcategory = (nodes: ScriptCategory[], parentId: string, child: ScriptCategory): ScriptCategory[] => {
  return nodes.map(node => {
    if (node.id === parentId) {
      const children = node.children ? [...node.children, child] : [child];
      return { ...node, children };
    }
    if (node.children) {
      return { ...node, children: addSubcategory(node.children, parentId, child) };
    }
    return node;
  });
};

const removeCategory = (nodes: ScriptCategory[], id: string): ScriptCategory[] => {
  return nodes
    .filter(node => node.id !== id)
    .map(node => ({
      ...node,
      children: node.children ? removeCategory(node.children, id) : node.children
    }));
};

const reorderCategories = (nodes: ScriptCategory[], dragId: string, targetId: string): ScriptCategory[] => {
  const dragIndex = nodes.findIndex(node => node.id === dragId);
  const targetIndex = nodes.findIndex(node => node.id === targetId);

  if (dragIndex !== -1 && targetIndex !== -1) {
    const next = [...nodes];
    const [dragged] = next.splice(dragIndex, 1);
    if (dragged) {
      next.splice(targetIndex, 0, dragged);
    }
    return next;
  }

  return nodes.map(node => ({
    ...node,
    children: node.children ? reorderCategories(node.children, dragId, targetId) : node.children
  }));
};

// Build category tree from flat script categories
function buildCategoryTree(scripts: Array<{ category?: string | null }>): ScriptCategory[] {
  const categoryMap = new Map<string, ScriptCategory>();

  scripts.forEach(script => {
    if (script.category && !categoryMap.has(script.category)) {
      categoryMap.set(script.category, {
        id: `cat-${script.category.toLowerCase().replace(/\s+/g, '-')}`,
        name: script.category,
        children: []
      });
    }
  });

  return Array.from(categoryMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export default function ScriptCategoryTree({
  categories: externalCategories,
  scripts: externalScripts,
  onSelectCategory
}: ScriptCategoryTreeProps) {
  const [internalCategories, setInternalCategories] = useState<ScriptCategory[]>([]);
  const [scripts, setScripts] = useState<ScriptItem[]>(externalScripts ?? []);
  const [loading, setLoading] = useState(!externalCategories && !externalScripts);
  const [error, setError] = useState<string>();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newCategoryParentId, setNewCategoryParentId] = useState<string | null>(null);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const categories = externalCategories ?? internalCategories;

  const fetchData = useCallback(async () => {
    if (externalCategories && externalScripts) return;

    try {
      setLoading(true);
      setError(undefined);

      const response = await fetchWithAuth('/scripts?includeSystem=true');
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        throw new Error('Failed to fetch scripts');
      }

      const data = await response.json();
      const scriptList = data.data ?? data.scripts ?? (Array.isArray(data) ? data : []);

      // Build categories from script data
      const categoryTree = buildCategoryTree(scriptList);
      setInternalCategories(categoryTree);
      setExpandedIds(new Set(categoryTree.map(cat => cat.id)));

      // Build script items
      const scriptItems: ScriptItem[] = scriptList.map((script: {
        id: string;
        name: string;
        category?: string | null;
        status?: string;
      }) => ({
        id: script.id,
        name: script.name,
        categoryId: script.category
          ? `cat-${script.category.toLowerCase().replace(/\s+/g, '-')}`
          : 'uncategorized',
        status: (script.status as ScriptItem['status']) || 'active'
      }));

      setScripts(scriptItems);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [externalCategories, externalScripts]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!contextMenu) return;

    const handleClose = () => setContextMenu(null);
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };

    window.addEventListener('click', handleClose);
    window.addEventListener('contextmenu', handleClose);
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('click', handleClose);
      window.removeEventListener('contextmenu', handleClose);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu]);

  const selectedCategoryName = useMemo(() => {
    if (!selectedCategoryId) return 'All Scripts';
    return findCategoryName(categories, selectedCategoryId) ?? 'Selected Category';
  }, [categories, selectedCategoryId]);

  const highlightedCategoryIds = useMemo(() => {
    if (!selectedCategoryId) return new Set<string>();
    const descendants = collectDescendantIds(categories, selectedCategoryId);
    return new Set([selectedCategoryId, ...descendants]);
  }, [categories, selectedCategoryId]);

  const setCategories = useCallback((updater: (prev: ScriptCategory[]) => ScriptCategory[]) => {
    if (externalCategories) return;
    setInternalCategories(prev => updater(prev));
  }, [externalCategories]);

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSelectCategory = (id: string) => {
    setSelectedCategoryId(id);
    onSelectCategory?.(id);
  };

  const openRename = (category: ScriptCategory) => {
    setRenameValue(category.name);
    setRenameTargetId(category.id);
  };

  const handleRename = async () => {
    if (!renameTargetId || renameValue.trim().length === 0) return;

    setSaving(true);
    try {
      // Note: When a categories API exists, this would PUT to /scripts/categories/:id
      // For now, we update the category name locally
      setCategories(prev => updateCategoryName(prev, renameTargetId, renameValue.trim()));

      // Update scripts that have this category to use the new name
      const oldCategoryName = findCategoryName(categories, renameTargetId);
      if (oldCategoryName) {
        // Update scripts with the old category to use the new name
        const scriptsToUpdate = scripts.filter(s => s.categoryId === renameTargetId);
        for (const script of scriptsToUpdate) {
          try {
            await fetchWithAuth(`/scripts/${script.id}`, {
              method: 'PUT',
              body: JSON.stringify({ category: renameValue.trim() })
            });
          } catch {
            console.warn(`Failed to update category for script ${script.id}`);
          }
        }
      }

      setRenameTargetId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename category');
    } finally {
      setSaving(false);
    }
  };

  const handleAddSubcategory = () => {
    if (!newCategoryParentId || newCategoryName.trim().length === 0) return;
    const newCategory = {
      id: createId(),
      name: newCategoryName.trim()
    };
    if (newCategoryParentId === 'root') {
      setCategories(prev => [...prev, newCategory]);
    } else {
      setCategories(prev => addSubcategory(prev, newCategoryParentId, newCategory));
      setExpandedIds(prev => new Set(prev).add(newCategoryParentId));
    }
    setNewCategoryParentId(null);
    setNewCategoryName('');
  };

  const handleDeleteCategory = () => {
    if (!deleteTargetId) return;
    setCategories(prev => removeCategory(prev, deleteTargetId));
    setSelectedCategoryId(prev => (prev === deleteTargetId ? null : prev));
    setDeleteTargetId(null);
  };

  const handleDrop = (dragId: string, targetId: string) => {
    if (dragId === targetId) return;
    setCategories(prev => reorderCategories(prev, dragId, targetId));
    setDraggingId(null);
    setDragOverId(null);
  };

  const renderCategory = (category: ScriptCategory, depth = 0) => {
    const isExpanded = expandedIds.has(category.id);
    const hasChildren = Boolean(category.children && category.children.length > 0);
    const isSelected = selectedCategoryId === category.id;
    const isDragOver = dragOverId === category.id && draggingId !== category.id;

    return (
      <div key={category.id}>
        <div
          className={cn(
            'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition',
            isSelected && 'bg-primary/10 text-primary',
            isDragOver && 'ring-1 ring-primary/50',
            !isSelected && 'hover:bg-muted/60'
          )}
          style={{ paddingLeft: depth * 16 }}
          draggable
          onDragStart={event => {
            setDraggingId(category.id);
            event.dataTransfer.setData('text/plain', category.id);
          }}
          onDragOver={event => {
            event.preventDefault();
            setDragOverId(category.id);
          }}
          onDragLeave={() => setDragOverId(null)}
          onDrop={event => {
            event.preventDefault();
            const dragId = draggingId ?? event.dataTransfer.getData('text/plain');
            if (dragId) {
              handleDrop(dragId, category.id);
            }
          }}
          onContextMenu={event => {
            event.preventDefault();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              categoryId: category.id
            });
          }}
        >
          <button
            type="button"
            onClick={() => hasChildren && toggleExpand(category.id)}
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground',
              hasChildren ? 'hover:bg-muted' : 'opacity-0'
            )}
          >
            <ChevronRight
              className={cn('h-4 w-4 transition-transform', isExpanded && 'rotate-90')}
            />
          </button>
          <Folder className="h-4 w-4 text-muted-foreground" />
          <button
            type="button"
            onClick={() => handleSelectCategory(category.id)}
            className="flex-1 truncate text-left"
          >
            {category.name}
          </button>
          {hasChildren && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {category.children?.length}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              openRename(category);
            }}
            className="opacity-0 transition group-hover:opacity-100"
          >
            <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
        {hasChildren && isExpanded && (
          <div className="mt-1 space-y-1">
            {category.children?.map(child => renderCategory(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
            <p className="mt-4 text-sm text-muted-foreground">Loading categories...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error && categories.length === 0) {
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
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="w-full lg:w-1/2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Script Categories</h2>
              <p className="text-sm text-muted-foreground">Organize scripts into nested folders.</p>
            </div>
            <button
              type="button"
              onClick={() => setNewCategoryParentId('root')}
              className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
            >
              <FolderPlus className="h-4 w-4" />
              New Category
            </button>
          </div>

          {error && (
            <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="mt-4 space-y-2">
            {categories.length === 0 ? (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No categories found. Create one to get started.
              </div>
            ) : (
              categories.map(category => renderCategory(category))
            )}
          </div>
        </div>

        <div className="w-full lg:w-1/2">
          <div className="rounded-lg border bg-muted/20 p-4">
            <p className="text-sm font-semibold">{selectedCategoryName}</p>
            <p className="text-xs text-muted-foreground">
              {selectedCategoryId
                ? `Scripts tagged under ${selectedCategoryName} and its subcategories`
                : 'Select a category to highlight its scripts.'}
            </p>
            <div className="mt-4 space-y-2 max-h-80 overflow-y-auto">
              {scripts.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                  No scripts found.
                </div>
              ) : (
                scripts.map(script => {
                  const isHighlighted = selectedCategoryId
                    ? highlightedCategoryIds.has(script.categoryId)
                    : false;
                  return (
                    <div
                      key={script.id}
                      className={cn(
                        'flex items-center justify-between rounded-md border bg-background px-3 py-2 text-sm transition',
                        isHighlighted && 'border-primary/40 bg-primary/5'
                      )}
                    >
                      <div>
                        <p className="font-medium">{script.name}</p>
                        <p className="text-xs text-muted-foreground">ID: {script.id}</p>
                      </div>
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', statusStyles[script.status])}>
                        {script.status}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {contextMenu && (
        <div
          className="fixed z-50 w-44 rounded-md border bg-card py-1 text-sm shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            onClick={() => {
              const category = findCategory(categories, contextMenu.categoryId);
              if (category) {
                openRename(category);
              }
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 hover:bg-muted"
          >
            <Pencil className="h-4 w-4" />
            Rename
          </button>
          <button
            type="button"
            onClick={() => {
              setNewCategoryParentId(contextMenu.categoryId);
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 hover:bg-muted"
          >
            <FolderPlus className="h-4 w-4" />
            Add Subcategory
          </button>
          <button
            type="button"
            onClick={() => {
              setDeleteTargetId(contextMenu.categoryId);
              setContextMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-red-600 hover:bg-red-500/10"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </div>
      )}

      {renameTargetId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <h3 className="text-lg font-semibold">Rename Category</h3>
            <p className="mt-1 text-sm text-muted-foreground">Update the category title.</p>
            <input
              value={renameValue}
              onChange={event => setRenameValue(event.target.value)}
              className="mt-4 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setRenameTargetId(null)}
                disabled={saving}
                className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRename}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {newCategoryParentId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <h3 className="text-lg font-semibold">
              {newCategoryParentId === 'root' ? 'New Category' : 'Add Subcategory'}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {newCategoryParentId === 'root'
                ? 'Create a new top-level category.'
                : 'Name the new subcategory.'}
            </p>
            <input
              value={newCategoryName}
              onChange={event => setNewCategoryName(event.target.value)}
              className="mt-4 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setNewCategoryParentId(null);
                  setNewCategoryName('');
                }}
                className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAddSubcategory}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTargetId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <h3 className="text-lg font-semibold text-red-600">Delete Category</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              This will remove the category and its subcategories. Scripts will remain but become uncategorized.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setDeleteTargetId(null)}
                className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteCategory}
                className="rounded-md bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
