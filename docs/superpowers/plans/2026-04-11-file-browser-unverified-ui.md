# File Browser Unverified Bulk-Op UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a distinct amber "Unverified" state in the file browser UI when a bulk file op (copy/move/delete/restore/upload) times out mid-flight on the agent, so users are told to refresh and verify instead of safely retrying a possibly-completed mutation.

**Architecture:** The API already emits `unverified: true` per item on 4 bulk endpoints (PR #391). We extend the upload endpoint to emit the same flag, widen the frontend `FileOpResult` and `FileActivity` types to carry it through, introduce a `UnverifiedOperationError` typed exception for upload, add a `summarizeBulkResults` helper that classifies a bulk response into `success`/`failure`/`unverified`, and render a new amber `AlertTriangle` badge in `FileActivityPanel`. `TrashView` gains a sibling `warning` state so unverified restores don't surface as red errors.

**Tech Stack:** TypeScript, Hono (API), Astro + React + Vitest + `@testing-library/react` (web). Co-located `.test.ts`/`.test.tsx` files per the project's Testing Standards.

**Spec reference:** `docs/superpowers/specs/2026-04-11-file-browser-unverified-ui-design.md`

---

## File Structure

**API (create):**
- `apps/api/src/routes/systemTools/fileBrowserHelpers.ts` — extend with a new `buildSingleItemUploadBody(result, fallback)` helper.

**API (modify):**
- `apps/api/src/routes/systemTools/fileBrowser.ts:192-195` — upload route's failure branch uses the new helper.
- `apps/api/src/routes/systemTools/fileBrowserHelpers.test.ts` — add cases for the new helper.

**Web (modify):**
- `apps/web/src/components/remote/fileOperations.ts` — extend `FileOpResult` with `unverified?: boolean`, add `UnverifiedOperationError` class and `uploadFile()` helper.
- `apps/web/src/components/remote/FileActivityPanel.tsx` — widen `FileActivity.result` union, add amber badge render, import `AlertTriangle`.
- `apps/web/src/components/remote/FileManager.tsx` — replace inline upload fetch with `uploadFile()`, add `summarizeBulkResults` helper, update `handleCopyTo`/`handleMoveTo`/`handleDelete`/`handleUpload` handlers, extend `TransferItem` status union.
- `apps/web/src/components/remote/TrashView.tsx` — rework `handleRestore` to inspect results; add `warning` state and amber banner render.

**Web (create):**
- `apps/web/src/components/remote/fileOperations.test.ts` — tests for `summarizeBulkResults` and `UnverifiedOperationError` parsing.
- `apps/web/src/components/remote/FileActivityPanel.test.tsx` — badge-state snapshot tests.
- `apps/web/src/components/remote/TrashView.test.tsx` — unverified/failed/mixed restore outcomes.

The `summarizeBulkResults` helper lives in `fileOperations.ts` (not inside `FileManager.tsx`) so it's independently testable without rendering the FileManager tree. This is a minor deviation from the spec's "local to FileManager" note — worth it for test isolation.

---

## Task 1: API — helper for upload timeout flag

**Files:**
- Modify: `apps/api/src/routes/systemTools/fileBrowserHelpers.ts`
- Test: `apps/api/src/routes/systemTools/fileBrowserHelpers.test.ts`

- [ ] **Step 1: Write failing tests for `buildSingleItemUploadBody`**

Add to `apps/api/src/routes/systemTools/fileBrowserHelpers.test.ts` at the end of the file:

```ts
describe('buildSingleItemUploadBody', () => {
  it('marks timeout results as unverified with the mutating message', () => {
    const result: CommandResult = { status: 'timeout', error: 'Command timed out after 30000ms' };
    const body = buildSingleItemUploadBody(result, 'Upload failed.');
    expect(body.unverified).toBe(true);
    expect(body.error).toMatch(/may have completed/i);
    expect(body.error).toMatch(/refresh to verify/i);
    expect(body.status).toBe(504);
  });

  it('does not mark hard failures as unverified', () => {
    const result: CommandResult = { status: 'failed', error: 'permission denied' };
    const body = buildSingleItemUploadBody(result, 'Upload failed.');
    expect(body.unverified).toBeUndefined();
    expect(body.error).toBe('permission denied');
    expect(body.status).toBe(502);
  });

  it('maps timeout-shaped error strings on failed status to unverified', () => {
    const result: CommandResult = { status: 'failed', error: 'agent: command timed out at 30s' };
    const body = buildSingleItemUploadBody(result, 'Upload failed.');
    expect(body.unverified).toBe(true);
    expect(body.status).toBe(504);
  });

  it('maps DEVICE_UNREACHABLE_ERROR to 503 without unverified', () => {
    const result: CommandResult = { status: 'failed', error: DEVICE_UNREACHABLE_ERROR };
    const body = buildSingleItemUploadBody(result, 'Upload failed.');
    expect(body.unverified).toBeUndefined();
    expect(body.status).toBe(503);
  });
});
```

Update the import line at the top of the file to include `buildSingleItemUploadBody`:

```ts
import {
  isCommandFailure,
  mapCommandFailure,
  buildBulkItemFailure,
  buildSingleItemUploadBody,
  auditErrorMessage,
} from './fileBrowserHelpers';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/systemTools/fileBrowserHelpers.test.ts`

Expected: FAIL with `buildSingleItemUploadBody is not a function` or `is not exported`.

- [ ] **Step 3: Implement `buildSingleItemUploadBody`**

Add to the end of `apps/api/src/routes/systemTools/fileBrowserHelpers.ts`:

```ts
// Single-item upload variant. Mirrors buildBulkItemFailure, but returns the
// full { error, unverified?, status } shape the upload route needs. We detect
// the timeout condition via mapCommandFailure's 504 status classification so
// we catch both status === 'timeout' and the "timed out" error-string fallback
// the agent uses on the failed path.
export function buildSingleItemUploadBody(
  result: CommandResult,
  fallback: string,
): { error: string; status: ContentfulStatusCode; unverified?: true } {
  const { message, status } = mapCommandFailure(result, fallback, { mutating: true });
  if (status === 504) {
    return { error: message, status, unverified: true };
  }
  return { error: message, status };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/systemTools/fileBrowserHelpers.test.ts`

Expected: PASS — all `buildSingleItemUploadBody` tests green, existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/systemTools/fileBrowserHelpers.ts apps/api/src/routes/systemTools/fileBrowserHelpers.test.ts
git commit -m "feat(api): add buildSingleItemUploadBody helper for unverified upload flag"
```

---

## Task 2: API — wire upload route to helper

**Files:**
- Modify: `apps/api/src/routes/systemTools/fileBrowser.ts:192-195`

- [ ] **Step 1: Replace the upload failure branch**

Current code at `fileBrowser.ts:192-195`:

```ts
if (isCommandFailure(result)) {
  const { message, status } = mapCommandFailure(result, 'Failed to write file.', { mutating: true });
  return c.json({ error: message }, status);
}
```

Replace with:

```ts
if (isCommandFailure(result)) {
  const body = buildSingleItemUploadBody(result, 'Failed to write file.');
  const { status, ...payload } = body;
  return c.json(payload, status);
}
```

Update the import at the top of the file to include `buildSingleItemUploadBody`. The existing imports should already have `isCommandFailure`, `mapCommandFailure`, `buildBulkItemFailure`, `auditErrorMessage`. Add the new one:

```ts
import {
  isCommandFailure,
  mapCommandFailure,
  buildBulkItemFailure,
  buildSingleItemUploadBody,
  auditErrorMessage,
} from './fileBrowserHelpers';
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd apps/api && npx tsc --noEmit`

Expected: PASS — no new errors introduced. Pre-existing errors in test files (see CLAUDE.md memory note) are acceptable; the upload route and its helper must compile clean.

- [ ] **Step 3: Run the helper test suite one more time to confirm no regression**

Run: `cd apps/api && npx vitest run src/routes/systemTools/fileBrowserHelpers.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/systemTools/fileBrowser.ts
git commit -m "fix(api): upload 504 response now carries unverified flag"
```

---

## Task 3: Web — extend `FileOpResult` type

**Files:**
- Modify: `apps/web/src/components/remote/fileOperations.ts:3-11`

- [ ] **Step 1: Add the `unverified` field to the type**

Current code at `fileOperations.ts:3-11`:

```ts
export type FileOpResult = {
  path?: string;
  sourcePath?: string;
  destPath?: string;
  trashId?: string;
  restoredPath?: string;
  status: 'success' | 'failure';
  error?: string;
};
```

Replace with:

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

- [ ] **Step 2: Verify type check passes**

Run: `cd apps/web && npx tsc --noEmit`

Expected: PASS — widening a type with an optional field is non-breaking.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/remote/fileOperations.ts
git commit -m "feat(web): add unverified field to FileOpResult type"
```

---

## Task 4: Web — `UnverifiedOperationError` and `uploadFile` helper

**Files:**
- Modify: `apps/web/src/components/remote/fileOperations.ts`
- Test: `apps/web/src/components/remote/fileOperations.test.ts` (create)

- [ ] **Step 1: Write failing tests**

Create `apps/web/src/components/remote/fileOperations.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UnverifiedOperationError,
  uploadFile,
  summarizeBulkResults,
  type FileOpResult,
} from './fileOperations';

const mockFetch = vi.fn();

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetch(...args),
}));

describe('UnverifiedOperationError', () => {
  it('has name "UnverifiedOperationError"', () => {
    const err = new UnverifiedOperationError('boom');
    expect(err.name).toBe('UnverifiedOperationError');
    expect(err.message).toBe('boom');
    expect(err.unverified).toBe(true);
  });

  it('is catchable via instanceof', () => {
    try {
      throw new UnverifiedOperationError('boom');
    } catch (err) {
      expect(err instanceof UnverifiedOperationError).toBe(true);
      expect(err instanceof Error).toBe(true);
    }
  });
});

describe('uploadFile', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves with data on 200', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { path: '/tmp/x', size: 42 } }),
    });

    const result = await uploadFile('dev-1', { path: '/tmp/x', content: 'Zm9v', encoding: 'base64' });
    expect(result).toEqual({ path: '/tmp/x', size: 42 });
  });

  it('throws UnverifiedOperationError when server returns unverified: true', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'refresh to verify', unverified: true }),
    });

    await expect(
      uploadFile('dev-1', { path: '/tmp/x', content: 'Zm9v', encoding: 'base64' }),
    ).rejects.toBeInstanceOf(UnverifiedOperationError);
  });

  it('throws plain Error on a non-unverified failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'permission denied' }),
    });

    await expect(
      uploadFile('dev-1', { path: '/tmp/x', content: 'Zm9v', encoding: 'base64' }),
    ).rejects.toThrow(/permission denied/);
  });

  it('falls back to generic message when JSON parse fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => {
        throw new Error('bad json');
      },
    });

    await expect(
      uploadFile('dev-1', { path: '/tmp/x', content: 'Zm9v', encoding: 'base64' }),
    ).rejects.toThrow(/Upload failed/);
  });
});

describe('summarizeBulkResults', () => {
  const ok = (path: string): FileOpResult => ({ path, status: 'success' });
  const fail = (path: string): FileOpResult => ({ path, status: 'failure', error: 'boom' });
  const unv = (path: string): FileOpResult => ({
    path,
    status: 'failure',
    error: 'timed out',
    unverified: true,
  });

  it('returns success outcome with no summary when all items succeeded', () => {
    expect(summarizeBulkResults([ok('a'), ok('b')])).toEqual({ result: 'success' });
  });

  it('returns failure outcome when all items hard-failed', () => {
    const out = summarizeBulkResults([fail('a'), fail('b')]);
    expect(out.result).toBe('failure');
    expect(out.summary).toBe('2 failed');
  });

  it('returns unverified outcome when all failed items are unverified', () => {
    const out = summarizeBulkResults([unv('a'), unv('b')]);
    expect(out.result).toBe('unverified');
    expect(out.summary).toBe('2 unverified — refresh to verify');
  });

  it('returns failure outcome on a mix of fail + unverified, with both counts', () => {
    const out = summarizeBulkResults([fail('a'), unv('b'), unv('c')]);
    expect(out.result).toBe('failure');
    expect(out.summary).toBe('1 failed, 2 unverified — refresh to verify');
  });

  it('returns unverified outcome on success + unverified mix', () => {
    const out = summarizeBulkResults([ok('a'), unv('b')]);
    expect(out.result).toBe('unverified');
    expect(out.summary).toBe('1 unverified — refresh to verify');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/remote/fileOperations.test.ts`

Expected: FAIL — `UnverifiedOperationError`, `uploadFile`, and `summarizeBulkResults` not exported.

- [ ] **Step 3: Implement the error class, `uploadFile`, and `summarizeBulkResults`**

Add to `apps/web/src/components/remote/fileOperations.ts` (after the existing functions, at the end of the file):

```ts
// Signals that a single-item mutating operation timed out and may or may not
// have completed on the device. Callers should render a "verify before
// retrying" state rather than a hard failure.
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
    if (json?.unverified) {
      throw new UnverifiedOperationError(json.error || 'Upload unverified');
    }
    throw new Error(json?.error || 'Upload failed');
  }
  const json = await response.json();
  return json.data ?? { path: body.path };
}

// Bulk outcome type shared by FileManager handlers and FileActivityPanel.
// result precedence: any hard failure wins; otherwise any unverified wins;
// otherwise success. summary is undefined on clean success, a "N failed" /
// "N unverified — refresh to verify" / mixed string otherwise.
export type BulkOutcome = {
  result: 'success' | 'failure' | 'unverified';
  summary?: string;
};

export function summarizeBulkResults(results: FileOpResult[]): BulkOutcome {
  const failures = results.filter((r) => r.status === 'failure' && !r.unverified);
  const unverified = results.filter((r) => r.unverified);
  if (failures.length === 0 && unverified.length === 0) {
    return { result: 'success' };
  }
  const parts: string[] = [];
  if (failures.length > 0) parts.push(`${failures.length} failed`);
  if (unverified.length > 0) parts.push(`${unverified.length} unverified`);
  const summary = unverified.length > 0
    ? `${parts.join(', ')} — refresh to verify`
    : parts.join(', ');
  const result: BulkOutcome['result'] = failures.length > 0 ? 'failure' : 'unverified';
  return { result, summary };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/remote/fileOperations.test.ts`

Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/remote/fileOperations.ts apps/web/src/components/remote/fileOperations.test.ts
git commit -m "feat(web): add uploadFile, UnverifiedOperationError, summarizeBulkResults"
```

---

## Task 5: Web — widen `FileActivity.result` and add amber badge

**Files:**
- Modify: `apps/web/src/components/remote/FileActivityPanel.tsx`
- Test: `apps/web/src/components/remote/FileActivityPanel.test.tsx` (create)

- [ ] **Step 1: Write failing tests**

Create `apps/web/src/components/remote/FileActivityPanel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import FileActivityPanel, { type FileActivity } from './FileActivityPanel';

function base(overrides: Partial<FileActivity>): FileActivity {
  return {
    id: 'a1',
    timestamp: new Date('2026-04-11T12:00:00Z').toISOString(),
    action: 'copy',
    paths: ['/tmp/foo'],
    result: 'success',
    ...overrides,
  };
}

function renderPanel(activities: FileActivity[]) {
  return render(
    <FileActivityPanel
      deviceId="dev-1"
      open
      onToggle={() => {}}
      activities={activities}
    />,
  );
}

describe('FileActivityPanel badges', () => {
  it('renders a green Success badge for result=success', () => {
    renderPanel([base({ result: 'success' })]);
    expect(screen.getByText('Success')).toBeInTheDocument();
  });

  it('renders a red Failed badge for result=failure', () => {
    renderPanel([base({ result: 'failure', error: '2 failed' })]);
    const badge = screen.getByText('Failed');
    expect(badge).toBeInTheDocument();
    expect(screen.getByText('2 failed')).toBeInTheDocument();
  });

  it('renders an amber Unverified badge for result=unverified', () => {
    renderPanel([
      base({
        result: 'unverified',
        error: '1 unverified — refresh to verify',
      }),
    ]);
    const badge = screen.getByText('Unverified');
    expect(badge).toBeInTheDocument();
    // The class name contains 'amber' to distinguish from red/green.
    expect(badge.className).toMatch(/amber/);
    expect(screen.getByText('1 unverified — refresh to verify')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/remote/FileActivityPanel.test.tsx`

Expected: FAIL — `unverified` is not a valid value for `result` yet; the rendered output also won't have an "Unverified" badge.

- [ ] **Step 3: Widen the type and add the amber badge render**

In `apps/web/src/components/remote/FileActivityPanel.tsx`:

1. Update the `lucide-react` import at the top to include `AlertTriangle`:

```tsx
import {
  Copy,
  ArrowRight,
  Trash2,
  RotateCcw,
  Upload,
  Download,
  X,
  ChevronLeft,
  ChevronRight,
  Clock,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
```

2. Widen `FileActivity.result` (around line 18):

```tsx
export type FileActivity = {
  id: string;
  timestamp: string;
  action: 'copy' | 'move' | 'delete' | 'restore' | 'upload' | 'download' | 'purge';
  paths: string[];
  result: 'success' | 'failure' | 'unverified';
  error?: string;
};
```

3. Replace the badge render block at `FileActivityPanel.tsx:154-167`:

```tsx
{activity.result === 'failure' ? (
  <span
    className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-400"
    title={activity.error || 'Operation failed'}
  >
    <AlertCircle className="h-2.5 w-2.5" />
    Failed
  </span>
) : activity.result === 'unverified' ? (
  <span
    className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400"
    title={activity.error || "Device didn't respond in time — refresh to verify"}
  >
    <AlertTriangle className="h-2.5 w-2.5" />
    Unverified
  </span>
) : (
  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
    <CheckCircle2 className="h-2.5 w-2.5" />
    Success
  </span>
)}
```

4. Update the error-detail render at `FileActivityPanel.tsx:188-195` (currently guarded by `isFailure`). Replace the earlier `const isFailure = activity.result === 'failure';` line with two flags and update the detail render:

```tsx
const isFailure = activity.result === 'failure';
const isUnverified = activity.result === 'unverified';
```

Replace the detail render block:

```tsx
{(isFailure || isUnverified) && activity.error && (
  <p
    className={cn(
      'mt-1 truncate text-[11px]',
      isUnverified ? 'text-amber-400/80' : 'text-red-400/80',
    )}
    title={activity.error}
  >
    {activity.error}
  </p>
)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/remote/FileActivityPanel.test.tsx`

Expected: PASS — all three badge states render correctly.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/remote/FileActivityPanel.tsx apps/web/src/components/remote/FileActivityPanel.test.tsx
git commit -m "feat(web): add amber Unverified badge state to FileActivityPanel"
```

---

## Task 6: Web — update `FileManager.tsx` bulk handlers

**Files:**
- Modify: `apps/web/src/components/remote/FileManager.tsx`

This task has no new test file — `summarizeBulkResults` is covered by Task 4's unit tests, and the FileManager handlers are thin glue. A render-level test would require mocking the entire FileManager tree (heavy). Relies on the helper test + manual dev-server verification in Task 8.

- [ ] **Step 1: Update imports**

At `FileManager.tsx:34`, replace:

```tsx
import { copyFiles, moveFiles, deleteFiles } from './fileOperations';
```

with:

```tsx
import {
  copyFiles,
  moveFiles,
  deleteFiles,
  uploadFile,
  summarizeBulkResults,
  UnverifiedOperationError,
} from './fileOperations';
```

- [ ] **Step 2: Widen `TransferItem` status**

At `FileManager.tsx:51-59`, replace:

```tsx
export type TransferItem = {
  id: string;
  filename: string;
  direction: 'upload' | 'download';
  status: 'pending' | 'transferring' | 'completed' | 'failed';
  progress: number;
  size: number;
  error?: string;
};
```

with:

```tsx
export type TransferItem = {
  id: string;
  filename: string;
  direction: 'upload' | 'download';
  status: 'pending' | 'transferring' | 'completed' | 'failed' | 'unverified';
  progress: number;
  size: number;
  error?: string;
};
```

- [ ] **Step 3: Update `addActivity` signature**

At `FileManager.tsx:606`, replace:

```tsx
const addActivity = useCallback((action: FileActivity['action'], paths: string[], result: 'success' | 'failure', error?: string) => {
```

with:

```tsx
const addActivity = useCallback((action: FileActivity['action'], paths: string[], result: FileActivity['result'], error?: string) => {
```

- [ ] **Step 4: Replace `handleCopyTo` failure logic**

At `FileManager.tsx:627-633`, replace:

```tsx
const response = await copyFiles(deviceId, items);
const failures = response.results.filter(r => r.status === 'failure');
if (failures.length > 0) {
  addActivity('copy', selectedPaths, 'failure', `${failures.length} items failed`);
} else {
  addActivity('copy', selectedPaths, 'success');
}
```

with:

```tsx
const response = await copyFiles(deviceId, items);
const { result, summary } = summarizeBulkResults(response.results);
addActivity('copy', selectedPaths, result, summary);
```

- [ ] **Step 5: Replace `handleMoveTo` failure logic**

At `FileManager.tsx:653-659`, replace:

```tsx
const response = await moveFiles(deviceId, items);
const failures = response.results.filter(r => r.status === 'failure');
if (failures.length > 0) {
  addActivity('move', selectedPaths, 'failure', `${failures.length} items failed`);
} else {
  addActivity('move', selectedPaths, 'success');
}
```

with:

```tsx
const response = await moveFiles(deviceId, items);
const { result, summary } = summarizeBulkResults(response.results);
addActivity('move', selectedPaths, result, summary);
```

- [ ] **Step 6: Replace `handleDelete` failure logic**

At `FileManager.tsx:675-681`, replace:

```tsx
const response = await deleteFiles(deviceId, selectedPaths, permanent);
const failures = response.results.filter(r => r.status === 'failure');
if (failures.length > 0) {
  addActivity('delete', selectedPaths, 'failure', `${failures.length} items failed`);
} else {
  addActivity('delete', selectedPaths, 'success');
}
```

with:

```tsx
const response = await deleteFiles(deviceId, selectedPaths, permanent);
const { result, summary } = summarizeBulkResults(response.results);
addActivity('delete', selectedPaths, result, summary);
```

- [ ] **Step 7: Route upload through `uploadFile`**

At `FileManager.tsx:485-528`, replace the entire block from the `// Upload file content to agent via system tools API` comment through the end of the `catch` block:

```tsx
// Upload file content to agent via system tools API
const remotePath = joinRemotePath(currentPath, file.name);

// Large files transit API → DB → WS → agent → disk; allow up to 2 minutes.
const uploadController = new AbortController();
const uploadTimeout = setTimeout(() => uploadController.abort(), 120_000);
let response: Response;
try {
  response = await fetchWithAuth(`/system-tools/devices/${deviceId}/files/upload`, {
    method: 'POST',
    body: JSON.stringify({
      path: remotePath,
      content,
      encoding: 'base64'
    }),
    signal: uploadController.signal
  });
} finally {
  clearTimeout(uploadTimeout);
}

if (!response.ok) {
  const err = await response.json().catch(() => ({ error: 'Upload failed' }));
  throw new Error(err.error || 'Upload failed');
}

setTransfers(prev => prev.map(t =>
  t.id === transferId ? { ...t, status: 'completed', progress: 100 } : t
));

// Refresh directory to show new file
fetchDirectory(currentPath);
} catch (error) {
  console.error('[FileManager] Upload failed:', error);
  setTransfers(prev => prev.map(t =>
    t.id === transferId ? {
      ...t,
      status: 'failed',
      error: error instanceof Error ? error.message : 'Upload failed'
    } : t
  ));
}
```

with:

```tsx
// Upload file content to agent via system tools API
const remotePath = joinRemotePath(currentPath, file.name);

// Large files transit API → DB → WS → agent → disk; allow up to 2 minutes.
const uploadController = new AbortController();
const uploadTimeout = setTimeout(() => uploadController.abort(), 120_000);
try {
  await uploadFile(
    deviceId,
    { path: remotePath, content, encoding: 'base64' },
    { signal: uploadController.signal },
  );
} finally {
  clearTimeout(uploadTimeout);
}

setTransfers(prev => prev.map(t =>
  t.id === transferId ? { ...t, status: 'completed', progress: 100 } : t
));

// Refresh directory to show new file
fetchDirectory(currentPath);
} catch (error) {
  console.error('[FileManager] Upload failed:', error);
  const message = error instanceof Error ? error.message : 'Upload failed';
  const status: TransferItem['status'] =
    error instanceof UnverifiedOperationError ? 'unverified' : 'failed';
  setTransfers(prev => prev.map(t =>
    t.id === transferId ? { ...t, status, error: message } : t
  ));
}
```

Upload outcomes stay in the transfer list only (same as today). The activity panel is for bulk copy/move/delete/restore; adding upload rows there would be a behavior change beyond the spec.

The existing `handleUpload` `useCallback` dep array is `[deviceId, currentPath, fetchDirectory]`. No change needed — we removed the `addActivity` call from the catch clause, so no new dependency is introduced.

- [ ] **Step 8: Add amber rendering for `unverified` transfer status**

The transfer list renders status icons at `FileManager.tsx:1516-1521`. Current code:

```tsx
{transfer.status === 'completed' && (
  <CheckCircle className="h-4 w-4 text-green-500" />
)}
{transfer.status === 'failed' && (
  <AlertCircle className="h-4 w-4 text-red-500" />
)}
```

Replace with:

```tsx
{transfer.status === 'completed' && (
  <CheckCircle className="h-4 w-4 text-green-500" />
)}
{transfer.status === 'failed' && (
  <AlertCircle className="h-4 w-4 text-red-500" />
)}
{transfer.status === 'unverified' && (
  <AlertTriangle className="h-4 w-4 text-amber-500" />
)}
```

Then update the transfer error-message render block at `FileManager.tsx:1511-1513` so unverified transfers show in amber instead of red:

```tsx
{transfer.error && (
  <p className={cn(
    'mt-1 text-xs',
    transfer.status === 'unverified' ? 'text-amber-500' : 'text-red-500',
  )}>
    {transfer.error}
  </p>
)}
```

And update the cancel-button condition at `FileManager.tsx:1527` so users can't "cancel" a finished unverified transfer (it's already past the active phase). The existing condition `['pending', 'transferring'].includes(transfer.status)` already excludes `'unverified'`, so no change needed — just verify this logic still holds when you edit.

Finally, update the `lucide-react` import at the top of `FileManager.tsx:2-30` to add `AlertTriangle`:

```tsx
import {
  Folder,
  File,
  Upload,
  Download,
  RefreshCw,
  ChevronRight,
  Home,
  ArrowUp,
  Loader2,
  X,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
  HardDrive,
  // ...rest of existing imports
  Trash2,
  Copy,
  Move,
  History,
  Square,
  CheckSquare,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
```

(Keep all existing imports; `AlertTriangle` is the only new one.)

- [ ] **Step 9: Verify type check passes**

Run: `cd apps/web && npx tsc --noEmit`

Expected: PASS — all handler changes type-check clean.

- [ ] **Step 10: Run the existing fileOperations tests to ensure no regression**

Run: `cd apps/web && npx vitest run src/components/remote/fileOperations.test.ts src/components/remote/FileActivityPanel.test.tsx`

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/components/remote/FileManager.tsx
git commit -m "feat(web): route FileManager bulk handlers through summarizeBulkResults"
```

---

## Task 7: Web — `TrashView.handleRestore` + amber warning banner

**Files:**
- Modify: `apps/web/src/components/remote/TrashView.tsx`
- Test: `apps/web/src/components/remote/TrashView.test.tsx` (create)

- [ ] **Step 1: Write failing tests**

Create `apps/web/src/components/remote/TrashView.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TrashView from './TrashView';

const mockListTrash = vi.fn();
const mockRestoreFromTrash = vi.fn();
const mockPurgeTrash = vi.fn();

vi.mock('./fileOperations', async () => {
  const actual = await vi.importActual<typeof import('./fileOperations')>('./fileOperations');
  return {
    ...actual,
    listTrash: (...args: unknown[]) => mockListTrash(...args),
    restoreFromTrash: (...args: unknown[]) => mockRestoreFromTrash(...args),
    purgeTrash: (...args: unknown[]) => mockPurgeTrash(...args),
  };
});

function seed() {
  mockListTrash.mockResolvedValue([
    {
      originalPath: '/tmp/one.txt',
      trashId: 'trash-1',
      deletedAt: '2026-04-11T10:00:00Z',
      deletedBy: 'me',
      isDirectory: false,
      sizeBytes: 10,
    },
    {
      originalPath: '/tmp/two.txt',
      trashId: 'trash-2',
      deletedAt: '2026-04-11T10:00:00Z',
      deletedBy: 'me',
      isDirectory: false,
      sizeBytes: 10,
    },
  ]);
}

describe('TrashView restore outcomes', () => {
  beforeEach(() => {
    mockListTrash.mockReset();
    mockRestoreFromTrash.mockReset();
    mockPurgeTrash.mockReset();
    seed();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows an amber warning when restore results are all unverified', async () => {
    mockRestoreFromTrash.mockResolvedValueOnce({
      results: [
        { trashId: 'trash-1', status: 'failure', error: 'timed out', unverified: true },
        { trashId: 'trash-2', status: 'failure', error: 'timed out', unverified: true },
      ],
    });

    render(<TrashView deviceId="dev-1" onRestore={() => {}} />);
    await screen.findByText('/tmp/one.txt');

    // Select both items via Select-all checkbox (the first checkbox in the table header)
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByText(/Restore Selected/));

    const banner = await screen.findByText(/2 unverified — refresh to verify/i);
    expect(banner.className).toMatch(/amber/);
  });

  it('shows a red error banner with counts on mixed failure + unverified', async () => {
    mockRestoreFromTrash.mockResolvedValueOnce({
      results: [
        { trashId: 'trash-1', status: 'failure', error: 'permission denied' },
        { trashId: 'trash-2', status: 'failure', error: 'timed out', unverified: true },
      ],
    });

    render(<TrashView deviceId="dev-1" onRestore={() => {}} />);
    await screen.findByText('/tmp/one.txt');

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByText(/Restore Selected/));

    await waitFor(() => {
      expect(screen.getByText(/1 failed/)).toBeInTheDocument();
      expect(screen.getByText(/1 unverified/)).toBeInTheDocument();
    });
  });

  it('does not show any banner on fully successful restore', async () => {
    mockRestoreFromTrash.mockResolvedValueOnce({
      results: [
        { trashId: 'trash-1', status: 'success', restoredPath: '/tmp/one.txt' },
        { trashId: 'trash-2', status: 'success', restoredPath: '/tmp/two.txt' },
      ],
    });
    // After restore, fetchTrash() is called again — return empty to satisfy it.
    mockListTrash.mockResolvedValueOnce([]);

    render(<TrashView deviceId="dev-1" onRestore={() => {}} />);
    await screen.findByText('/tmp/one.txt');

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByText(/Restore Selected/));

    await waitFor(() => {
      expect(screen.queryByText(/failed/i)).toBeNull();
      expect(screen.queryByText(/unverified/i)).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/remote/TrashView.test.tsx`

Expected: FAIL — `handleRestore` currently discards results, so neither the amber warning nor the per-item count output exists.

- [ ] **Step 3: Add `warning` state and rework `handleRestore`**

In `apps/web/src/components/remote/TrashView.tsx`:

1. Update imports at the top to include `summarizeBulkResults`:

```tsx
import {
  listTrash,
  restoreFromTrash,
  purgeTrash,
  summarizeBulkResults,
  type TrashItem,
} from './fileOperations';
```

2. Add the `warning` state next to `error` at `TrashView.tsx:51`. After the existing `const [error, setError] = useState<string | null>(null);` line, add:

```tsx
const [warning, setWarning] = useState<string | null>(null);
```

3. Replace `handleRestore` at `TrashView.tsx:100-116`:

```tsx
const handleRestore = useCallback(async () => {
  const ids = Array.from(selected);
  if (ids.length === 0) return;

  setActionLoading('restore');
  setError(null);
  setWarning(null);
  try {
    const response = await restoreFromTrash(deviceId, ids);
    const { result, summary } = summarizeBulkResults(response.results);
    if (result === 'failure') {
      setError(summary ?? 'Restore failed');
    } else if (result === 'unverified') {
      setWarning(summary ?? 'Some items unverified — refresh to verify');
    }
    await fetchTrash();
    onRestore();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Restore failed';
    setError(message);
  } finally {
    setActionLoading(null);
  }
}, [deviceId, selected, fetchTrash, onRestore]);
```

4. Clear `warning` in `fetchTrash` the same way `error` is cleared. Replace the opening of `fetchTrash` at `TrashView.tsx:58-61`:

```tsx
const fetchTrash = useCallback(async () => {
  setLoading(true);
  setError(null);
  setWarning(null);
  try {
```

5. Add the amber warning banner render. Find the existing red error banner block at `TrashView.tsx:268-273`:

```tsx
{/* Error banner (inline, when items still visible) */}
{error && (
  <div className="border-b border-red-800 bg-red-900/30 px-4 py-2 text-xs text-red-400">
    {error}
  </div>
)}
```

Add the warning banner directly after it:

```tsx
{/* Warning banner — unverified outcomes */}
{warning && (
  <div className="border-b border-amber-800 bg-amber-900/30 px-4 py-2 text-xs text-amber-400">
    {warning}
  </div>
)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/remote/TrashView.test.tsx`

Expected: PASS — all three outcome cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/remote/TrashView.tsx apps/web/src/components/remote/TrashView.test.tsx
git commit -m "feat(web): TrashView surfaces unverified restore outcomes in amber"
```

---

## Task 8: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full web test suite**

Run: `cd apps/web && npx vitest run src/components/remote/`

Expected: PASS — all `fileOperations.test.ts`, `FileActivityPanel.test.tsx`, `TrashView.test.tsx`, and pre-existing co-located tests (`RegistryEditor.test.tsx`, `SessionHistory.test.tsx`, `filePathUtils.test.ts`) green.

- [ ] **Step 2: Run the API test suite**

Run: `cd apps/api && npx vitest run src/routes/systemTools/`

Expected: PASS — `fileBrowserHelpers.test.ts` including new `buildSingleItemUploadBody` cases.

- [ ] **Step 3: Type-check both sides**

Run: `cd apps/api && npx tsc --noEmit`

Expected: no new errors beyond the pre-existing test-file errors documented in CLAUDE.md memory.

Run: `cd apps/web && npx tsc --noEmit`

Expected: PASS — no new errors.

- [ ] **Step 4: Manual smoke test (optional but recommended per CLAUDE.md UI guidance)**

If you have a dev environment running and a device that can be taken briefly offline:

1. Start the dev servers: `pnpm dev` (from repo root).
2. Open the file browser for a reachable device.
3. Pick a file, start a copy operation, and immediately disconnect the agent's network (simulate transient loss — on macOS `sudo ifconfig en0 down` then `up`, or block the agent's WS port in a firewall for ~30s).
4. Wait for the bulk op to return. Verify:
   - Activity panel shows an amber `AlertTriangle` "Unverified" badge.
   - Message reads "N unverified — refresh to verify".
5. Repeat with the trash view restore and with an upload. Both should show amber treatment on the timeout path.
6. Test a genuine failure (e.g., copy to a read-only path): confirm the red "Failed" badge still appears — no regression.

If you cannot reliably induce a timeout, skip this step and rely on the unit tests. Document in the PR that you did not manually verify the timeout path.

- [ ] **Step 5: Final commit if any drift**

If the verification steps uncovered lint or type drift, fix it and add one cleanup commit:

```bash
git add -p
git commit -m "chore: fixups from verification pass"
```

Otherwise skip.

---

## Out of scope

- **Automatic directory refresh after unverified ops** — user still chooses when to refresh.
- **Per-path unverified markers in the activity panel** — the summary string is sufficient for the reported gap.
- **Idempotent retry** — requires agent-side guarantees outside this follow-up.
- **`trash/purge` changes** — single-command, already uses the existing "refresh to verify" message path.
