# File Browser — Unverified Bulk-Op UI

**Date:** 2026-04-11
**Follow-up to:** PR #391 (`fix(api): better file browser UX when device is intermittently reachable`)
**Scope:** Frontend-visible distinction between hard failures and "unverified" (timed-out mid-op) results on file browser bulk operations, plus the small API change needed to let upload participate in the same contract.

## Problem

PR #391 added a per-item `unverified: true` field on bulk file-op responses (`copy`, `move`, `delete`, `trash/restore`) to flag operations that timed out while talking to the agent. The field is set when the API cannot tell whether the operation completed on the device — retrying blindly risks compounding damage (e.g., permanently deleting a file that was rotated into a just-freed path).

The frontend currently ignores the field entirely:

- `FileOpResult` in `apps/web/src/components/remote/fileOperations.ts:3-11` omits `unverified`; it's dropped at the type boundary.
- `FileManager.tsx` handlers (`handleCopyTo:617`, `handleMoveTo:644`, `handleDelete:670`) filter `status === 'failure'` and log a flat "N items failed" string. No distinction.
- `TrashView.handleRestore:100` awaits `restoreFromTrash` but *discards the results array entirely*; per-item outcomes are invisible there.
- `FileActivityPanel.tsx:154-167` renders a binary red/green badge. No third state.
- `FileManager.handleUpload:449` inline-calls `fetch` for upload and catches thrown errors. The API's 504 "refresh to verify before retrying" message lands in the red "Failed" badge along with real failures.

This is not a security issue; it is a data-safety / integrity risk. Users who see "Failed" on an operation that actually completed will retry and may mutate a filesystem state they did not intend.

## Goals

1. Surface a distinct, amber "Unverified" activity badge for any bulk op where the API reported `unverified: true`.
2. Keep the hard-failure red "Failed" badge for genuine failures.
3. Bring upload into the same contract by extending the upload API's timeout response and routing upload through the shared fileOperations layer.
4. Fix `TrashView` to actually inspect per-item restore results.
5. No behavior change on the green happy path.

## Non-goals

- Automatic refresh after an unverified op. User still chooses when to refresh — the badge just nudges them to verify.
- A retry-with-idempotency mechanism. Out of scope; too large for this follow-up.
- Changes to `trash/purge`, which is a single command (not per-item) and uses the existing 504 "refresh to verify" message path.
- Changes to bulk endpoints already emitting `unverified`. They are correct as-is.

## Design

### 1. API — upload endpoint

**File:** `apps/api/src/routes/systemTools/fileBrowser.ts:192`

On the `isCommandFailure(result)` branch of the upload route, surface the `unverified` distinction in the JSON body:

```ts
if (isCommandFailure(result)) {
  const { message, status } = mapCommandFailure(result, 'Failed to write file.', { mutating: true });
  const unverified = result.status === 'timeout';
  return c.json(unverified ? { error: message, unverified: true } : { error: message }, status);
}
```

No other bulk endpoints change — they already emit `unverified` per-item.

### 2. Frontend types

**File:** `apps/web/src/components/remote/fileOperations.ts:3-11`

Add `unverified?: boolean` to `FileOpResult`:

```ts
export type FileOpResult = {
  path?: string;
  sourcePath?: string;
  destPath?: string;
  trashId?: string;
  restoredPath?: string;
  status: 'success' | 'failure';
  error?: string;
  unverified?: boolean;
};
```

Copy/move/delete/restore need no other shape changes — `{ results: FileOpResult[] }` will pass the flag through once the type admits it.

### 3. Upload moved into `fileOperations.ts`

**File:** `apps/web/src/components/remote/fileOperations.ts`

Introduce a typed error and an `uploadFile` helper. The typed error keeps the calling code's existing `try/catch` shape in `FileManager.handleUpload`:

```ts
export class UnverifiedOperationError extends Error {
  readonly unverified = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'UnverifiedOperationError';
  }
}

export async function uploadFile(
  deviceId: string,
  body: { path: string; content: string; encoding?: string },
  opts?: { signal?: AbortSignal },
): Promise<{ path: string; size?: number }> {
  const response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/upload`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({ error: 'Upload failed' }));
    if (json?.unverified) throw new UnverifiedOperationError(json.error || 'Upload unverified');
    throw new Error(json?.error || 'Upload failed');
  }
  const json = await response.json();
  return json.data ?? { path: body.path };
}
```

The existing `handleUpload:489-503` `fetchWithAuth` block is replaced with `await uploadFile(deviceId, { path, content, encoding }, { signal: uploadController.signal })` and a `catch` clause that distinguishes `UnverifiedOperationError` from plain `Error`. The `AbortController` / 120s guard stays in `handleUpload`; `uploadFile` just forwards the signal.

### 4. `FileActivity` type + activity panel

**File:** `apps/web/src/components/remote/FileActivityPanel.tsx`

Widen the result union:

```ts
export type FileActivity = {
  id: string;
  timestamp: string;
  action: 'copy' | 'move' | 'delete' | 'restore' | 'upload' | 'download' | 'purge';
  paths: string[];
  result: 'success' | 'failure' | 'unverified';
  error?: string;
};
```

Badge block at `FileActivityPanel.tsx:154-167` becomes a three-way render:

- `success` → existing green `CheckCircle2` "Success"
- `failure` → existing red `AlertCircle` "Failed"
- `unverified` → new amber `AlertTriangle` "Unverified" with `bg-amber-500/15 text-amber-400`, tooltip: `"Device didn't respond in time — refresh to verify"`

Error detail row at `FileActivityPanel.tsx:188-195`: when `result === 'unverified'`, use `text-amber-400/80` instead of `text-red-400/80`. Same render branch, different color class.

Import `AlertTriangle` from `lucide-react`.

### 5. `FileManager.tsx` handlers

**File:** `apps/web/src/components/remote/FileManager.tsx`

Add a local helper, co-located with `addActivity`:

```ts
type BulkOutcome = { result: FileActivity['result']; summary?: string };

function summarizeBulkResults(results: FileOpResult[]): BulkOutcome {
  const failures = results.filter(r => r.status === 'failure' && !r.unverified);
  const unverified = results.filter(r => r.unverified);
  if (failures.length === 0 && unverified.length === 0) return { result: 'success' };
  const parts: string[] = [];
  if (failures.length > 0) parts.push(`${failures.length} failed`);
  if (unverified.length > 0) parts.push(`${unverified.length} unverified`);
  const summary = unverified.length > 0
    ? `${parts.join(', ')} — refresh to verify`
    : parts.join(', ');
  const result: FileActivity['result'] = failures.length > 0 ? 'failure' : 'unverified';
  return { result, summary };
}
```

`handleCopyTo:627-640`, `handleMoveTo:653-666`, `handleDelete:675-688` each collapse their current filter-and-log block to:

```ts
const { result, summary } = summarizeBulkResults(response.results);
addActivity('copy', selectedPaths, result, summary);
```

(with the appropriate action string).

The `catch` clauses on each handler stay as `addActivity(..., 'failure', message)` — a thrown exception is a hard failure, not an unverified state, because it means the request never got a bulk result.

`handleUpload:518-528` catch clause is extended:

```ts
} catch (error) {
  if (error instanceof UnverifiedOperationError) {
    setTransfers(prev => prev.map(t => t.id === transferId
      ? { ...t, status: 'unverified', error: error.message }
      : t));
    addActivity('upload', [path], 'unverified', `${error.message}`);
  } else {
    // existing failure path
  }
}
```

The in-flight `FileTransfer` type at `FileManager.tsx:54` gains `'unverified'` as a possible status so the transfer list shows a matching treatment (reusing the amber color).

### 6. `TrashView.tsx` — `handleRestore`

**File:** `apps/web/src/components/remote/TrashView.tsx:100-116`

Currently throws away `restoreFromTrash`'s results. Rework:

```ts
const handleRestore = useCallback(async () => {
  const ids = Array.from(selected);
  if (ids.length === 0) return;

  setActionLoading('restore');
  setError(null);
  setWarning(null);
  try {
    const response = await restoreFromTrash(deviceId, ids);
    const failures = response.results.filter(r => r.status === 'failure' && !r.unverified);
    const unverified = response.results.filter(r => r.unverified);
    if (failures.length > 0) {
      setError(`${failures.length} failed${unverified.length ? `, ${unverified.length} unverified` : ''}. Refresh to verify.`);
    } else if (unverified.length > 0) {
      setWarning(`${unverified.length} unverified — refresh to verify.`);
    }
    await fetchTrash();
    onRestore();
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Restore failed');
  } finally {
    setActionLoading(null);
  }
}, [deviceId, selected, fetchTrash, onRestore]);
```

Add a `warning` state alongside the existing `error` state and render it in amber where the error banner currently renders red.

### 7. Tests

**API (Vitest):**

- `apps/api/src/routes/systemTools/fileBrowser.test.ts` (or add if missing): assert upload's 504 timeout path returns `{ error, unverified: true }`. The existing `fileBrowserHelpers.test.ts` already covers `buildBulkItemFailure`.

**Web (Vitest + jsdom):**

- `FileActivityPanel.test.tsx`: snapshot one row for each of the three `result` states; assert the amber badge text/color for `unverified`.
- `FileManager.test.tsx`: three handler tests (`handleCopyTo`, `handleMoveTo`, `handleDelete`) with mixed results (all success / all fail / all unverified / mixed fail + unverified) asserting the `addActivity` call receives the right `(result, summary)`.
- `TrashView.test.tsx`: unverified-only restore shows the amber warning; mixed restore shows the red error with unverified count.

Follow the rules in `CLAUDE.md` → Testing Standards: tests co-located, multi-tenant not applicable (pure UI state), cover happy/unverified/failure/mixed branches.

### 8. File-size guideline

`FileManager.tsx` is already a large file. The helper `summarizeBulkResults` goes local for now (one file, one helper, <30 lines). If a future change needs it elsewhere, extract to `fileOperations.ts` at that point. No proactive split.

## Out of scope / future work

- **Automatic state refresh after unverified ops.** Could call `fetchDirectory(currentPath)` unconditionally after any unverified outcome. Left out deliberately — user might be looking at the error.
- **Per-path detail drill-down.** The activity panel currently lists all paths flatly; we could mark individual paths as unverified. Ignored for now — the summary string is enough for the reported gap.
- **Idempotent retry.** A "retry this op" button that re-issues only failed items and skips unverified ones. Requires agent-side idempotency guarantees we don't have.

## Risks

- **Visual noise.** Adding a third badge color in a 300px panel could feel busy. Mitigation: amber is used nowhere else in this panel, so a mixed row still reads cleanly.
- **Test flakiness around `FileManager.tsx`.** The file is large and has no existing test that we know of; adding one may uncover lint/mocking churn. If so, scope the new test file narrowly (just the helper + one handler) rather than fighting an exhaustive render test.
- **`UnverifiedOperationError` import chain.** `FileManager.tsx` will need to import it from `fileOperations.ts`. Minor, but means `fileOperations.ts` goes from data-shape module to type-exporter. Acceptable.
