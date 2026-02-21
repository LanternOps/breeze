# File Browser Improvements: Copy, Move, Delete with Auditing

**Date**: 2026-02-20
**Status**: Approved
**Approach**: Extend existing routes + agent-side recycle bin (Approach A)

## Summary

Add copy, move, and delete operations to the file browser with:
- Multi-select batch operations
- Agent-side recycle bin (`.breeze-trash/`) for recoverable deletes
- Per-item audit logging
- Activity panel in the file browser UI
- Trash management UI

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Copy scope | Same device only | Avoids cross-device relay complexity |
| Delete safety | Confirm + recycle bin | Recoverable even if API is down |
| Move/Rename | Unified action | Agent already handles both via `file_rename` |
| Batch ops | Multi-select from start | Full batch support from day one |
| Audit UI | File browser panel + org audit log | Visibility at both levels |

## Agent Layer (Go)

### New Command: `file_copy`

Location: `agent/internal/remote/tools/fileops.go`

- New `CmdFileCopy = "file_copy"` constant in `types.go`
- `CopyFile(payload)` function taking `sourcePath` and `destPath`
- Uses `io.Copy` for files, recursive walk for directories
- Same safety guards: denied system paths, `filepath.Clean()` normalization
- Preserves file permissions on copy

### Modified Command: `file_delete` → Trash Support

- Instead of `os.Remove`/`os.RemoveAll`, moves files to `~/.breeze-trash/<timestamp>-<basename>/`
- JSON metadata sidecar file captures: original path, deletion timestamp, actor info
- Existing `recursive` flag and system path protections remain
- New `permanent` boolean flag bypasses trash when explicitly requested
- Lazy auto-purge: items older than 30 days cleaned up on next trash operation

### New Commands: Trash Management

| Command | Function | Description |
|---------|----------|-------------|
| `file_trash_list` | `TrashList()` | Lists `~/.breeze-trash/` contents with metadata |
| `file_trash_restore` | `TrashRestore()` | Moves trashed item back to original path |
| `file_trash_purge` | `TrashPurge()` | Permanently deletes items from trash |

### Handler Registration

Add to `agent/internal/heartbeat/handlers.go`:
```go
tools.CmdFileCopy:         handleFileCopy,
tools.CmdFileTrashList:    handleFileTrashList,
tools.CmdFileTrashRestore: handleFileTrashRestore,
tools.CmdFileTrashPurge:   handleFileTrashPurge,
```

## API Layer (TypeScript)

### New Routes

All routes under `/system-tools/devices/:deviceId/files/`:

| Route | Method | Agent Command | Permission | Description |
|-------|--------|---------------|------------|-------------|
| `/files/copy` | POST | `file_copy` | `devices.execute` | Copy file/dir to new path |
| `/files/move` | POST | `file_rename` | `devices.execute` | Move/rename (reuses existing) |
| `/files/delete` | POST | `file_delete` | `devices.execute` | Move to trash (batch) |
| `/files/trash` | GET | `file_trash_list` | `devices.read` | List trashed items |
| `/files/trash/restore` | POST | `file_trash_restore` | `devices.execute` | Restore from trash |
| `/files/trash/purge` | POST | `file_trash_purge` | `devices.execute` | Permanently delete from trash |

### Request Bodies

```typescript
// POST /files/copy
{ items: [{ sourcePath: string, destPath: string }] }

// POST /files/move
{ items: [{ sourcePath: string, destPath: string }] }

// POST /files/delete
{ paths: string[], permanent?: boolean }

// POST /files/trash/restore
{ trashIds: string[] }

// POST /files/trash/purge
{ trashIds?: string[] }  // empty = purge all
```

### Zod Schemas

New schemas in `apps/api/src/routes/systemTools/schemas.ts`:
- `fileCopyBodySchema`
- `fileMoveBodySchema`
- `fileDeleteBodySchema`
- `fileTrashRestoreBodySchema`
- `fileTrashPurgeBodySchema`

### Command Queue Updates

In `apps/api/src/services/commandQueue.ts`:
- Add: `FILE_COPY`, `FILE_TRASH_LIST`, `FILE_TRASH_RESTORE`, `FILE_TRASH_PURGE` to `CommandTypes`
- Add: `FILE_COPY`, `FILE_TRASH_RESTORE`, `FILE_TRASH_PURGE` to `AUDITED_COMMANDS`

### Audit Logging

Each individual item in a batch gets its own `createAuditLog()` call:
- `action`: `file_copy`, `file_move`, `file_delete`, `file_restore`, `file_trash_purge`
- `details`: `{ sourcePath, destPath, itemCount, permanent }` as appropriate
- `result`: `success` | `failure` per item

## Frontend (React)

### Multi-Select

- Checkbox column on each file row (visible on hover or when any item selected)
- "Select all" checkbox in table header
- Selection count in floating action bar at bottom of file list

### Action Bar (visible when 1+ items selected)

Buttons: **Copy to...** | **Move to...** | **Delete** | **Download**

### Context Menu (right-click single file)

Items: Copy to... | Move to... | Delete | Download

### Folder Picker Dialog (shared by Copy and Move)

- Modal with directory navigation (reuses existing file list component)
- Breadcrumbs, back button, double-click to navigate
- "Select this folder" confirmation button
- Shows current destination path

### Trash View

- Toggle button in toolbar: "Trash (N items)"
- When active, shows trashed items with original path, deletion date, deleter
- Actions: Restore, Permanently Delete, Purge All

### Activity Panel

- Collapsible sidebar in file browser
- Recent file operations tracked in local component state
- Shows: timestamp, action, path, result
- Auto-populated from copy/move/delete/restore operations

### Progress and Feedback

- Batch operations show in existing transfer queue panel
- Toast notifications for success/failure
- Optimistic UI: items fade out on delete, refresh on confirmation
- Action buttons disabled while operations in flight

## Error Handling & Security

### Path Validation

- API: Zod validation (max 2048 chars, no null bytes)
- API: Reject paths with `..` segments before sending to agent
- Agent: `filepath.Clean()` normalization + denied system path checks

### Batch Error Handling

- Each item executes independently — one failure doesn't abort the batch
- API returns per-item results: `{ results: [{ path, status, error? }] }`
- Audit log records per-item success/failure

### Trash Safety

- Agent creates trash directory with `0700` permissions
- Metadata sidecar records original path, timestamp, and actor info
- Auto-purge: items older than 30 days cleaned on next trash operation

### Concurrency

- Operations serialized per-device through command queue
- Frontend disables actions while operations in flight

### Permissions

- No changes to permission model
- `devices.execute` covers all mutations
- MFA requirement remains for all system tools
