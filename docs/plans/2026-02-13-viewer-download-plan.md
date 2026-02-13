# Viewer Download Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the "Download" button in the ConnectDesktopButton fallback modal detect the user's OS and directly download the correct Breeze Viewer binary.

**Architecture:** A pure client-side utility (`viewerDownload.ts`) detects the OS via `navigator` APIs and constructs a GitHub Releases download URL. The existing modal consumes this utility. When OS is unknown, all platform download links are shown.

**Tech Stack:** TypeScript, React, Vitest (jsdom)

---

### Task 1: Create viewerDownload utility with tests

**Files:**
- Create: `apps/web/src/lib/viewerDownload.ts`
- Create: `apps/web/src/lib/viewerDownload.test.ts`

**Step 1: Write the test file**

Create `apps/web/src/lib/viewerDownload.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getViewerDownloadInfo, getAllViewerDownloads, VIEWER_DOWNLOADS_FALLBACK_URL } from './viewerDownload';

describe('getViewerDownloadInfo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns macOS info for Mac platform', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'macOS' }, platform: '', userAgent: '' });
    const info = getViewerDownloadInfo();
    expect(info).not.toBeNull();
    expect(info!.os).toBe('macOS');
    expect(info!.filename).toBe('breeze-viewer-macos.dmg');
    expect(info!.url).toContain('breeze-viewer-macos.dmg');
  });

  it('returns Windows info for Windows platform', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'Windows' }, platform: '', userAgent: '' });
    const info = getViewerDownloadInfo();
    expect(info).not.toBeNull();
    expect(info!.os).toBe('Windows');
    expect(info!.filename).toBe('breeze-viewer-windows.msi');
    expect(info!.url).toContain('breeze-viewer-windows.msi');
  });

  it('returns Linux info for Linux platform', () => {
    vi.stubGlobal('navigator', { userAgentData: undefined, platform: 'Linux x86_64', userAgent: '' });
    const info = getViewerDownloadInfo();
    expect(info).not.toBeNull();
    expect(info!.os).toBe('Linux');
    expect(info!.filename).toBe('breeze-viewer-linux.AppImage');
    expect(info!.url).toContain('breeze-viewer-linux.AppImage');
  });

  it('falls back to navigator.platform when userAgentData unavailable', () => {
    vi.stubGlobal('navigator', { userAgentData: undefined, platform: 'MacIntel', userAgent: '' });
    const info = getViewerDownloadInfo();
    expect(info).not.toBeNull();
    expect(info!.os).toBe('macOS');
  });

  it('falls back to navigator.userAgent as last resort', () => {
    vi.stubGlobal('navigator', { userAgentData: undefined, platform: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    const info = getViewerDownloadInfo();
    expect(info).not.toBeNull();
    expect(info!.os).toBe('Windows');
  });

  it('returns null for unknown OS', () => {
    vi.stubGlobal('navigator', { userAgentData: undefined, platform: 'UnknownOS', userAgent: 'SomeBot/1.0' });
    const info = getViewerDownloadInfo();
    expect(info).toBeNull();
  });
});

describe('getAllViewerDownloads', () => {
  it('returns entries for all three platforms', () => {
    const all = getAllViewerDownloads();
    expect(all).toHaveLength(3);
    const osNames = all.map(d => d.os);
    expect(osNames).toContain('macOS');
    expect(osNames).toContain('Windows');
    expect(osNames).toContain('Linux');
  });

  it('each entry has url, filename, and os', () => {
    const all = getAllViewerDownloads();
    for (const entry of all) {
      expect(entry.os).toBeTruthy();
      expect(entry.filename).toBeTruthy();
      expect(entry.url).toContain('releases/latest/download/');
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/toddhebebrand/breeze && pnpm --filter @breeze/web test -- --run src/lib/viewerDownload.test.ts`
Expected: FAIL — module not found

**Step 3: Write the utility**

Create `apps/web/src/lib/viewerDownload.ts`:

```typescript
interface ViewerDownloadInfo {
  os: string;
  url: string;
  filename: string;
}

const REPO = 'toddhebebrand/breeze';
const BASE_URL = `https://github.com/${REPO}/releases/latest/download`;

export const VIEWER_DOWNLOADS_FALLBACK_URL = `https://github.com/${REPO}/releases/latest`;

const PLATFORMS: ViewerDownloadInfo[] = [
  { os: 'macOS', filename: 'breeze-viewer-macos.dmg', url: `${BASE_URL}/breeze-viewer-macos.dmg` },
  { os: 'Windows', filename: 'breeze-viewer-windows.msi', url: `${BASE_URL}/breeze-viewer-windows.msi` },
  { os: 'Linux', filename: 'breeze-viewer-linux.AppImage', url: `${BASE_URL}/breeze-viewer-linux.AppImage` },
];

function detectOS(): string | null {
  // Modern API (Chromium 93+)
  const uaData = (navigator as any).userAgentData;
  if (uaData?.platform) {
    const p = uaData.platform.toLowerCase();
    if (p.includes('mac')) return 'macOS';
    if (p.includes('win')) return 'Windows';
    if (p.includes('linux')) return 'Linux';
  }

  // Fallback: navigator.platform
  const platform = navigator.platform?.toLowerCase() ?? '';
  if (platform.includes('mac')) return 'macOS';
  if (platform.includes('win')) return 'Windows';
  if (platform.includes('linux')) return 'Linux';

  // Last resort: user agent string
  const ua = navigator.userAgent?.toLowerCase() ?? '';
  if (ua.includes('mac')) return 'macOS';
  if (ua.includes('win')) return 'Windows';
  if (ua.includes('linux')) return 'Linux';

  return null;
}

export function getViewerDownloadInfo(): ViewerDownloadInfo | null {
  const os = detectOS();
  if (!os) return null;
  return PLATFORMS.find(p => p.os === os) ?? null;
}

export function getAllViewerDownloads(): ViewerDownloadInfo[] {
  return PLATFORMS;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/toddhebebrand/breeze && pnpm --filter @breeze/web test -- --run src/lib/viewerDownload.test.ts`
Expected: All 7 tests PASS

**Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/web/src/lib/viewerDownload.ts apps/web/src/lib/viewerDownload.test.ts
git commit -m "feat: add OS-aware viewer download utility with tests"
```

---

### Task 2: Wire download button in ConnectDesktopButton modal

**Files:**
- Modify: `apps/web/src/components/remote/ConnectDesktopButton.tsx`

**Step 1: Update imports and add download info**

At the top of `ConnectDesktopButton.tsx`, add import:

```typescript
import { getViewerDownloadInfo, getAllViewerDownloads } from '@/lib/viewerDownload';
```

**Step 2: Replace the fallback modal's download section (lines 141-148)**

Replace the existing download `<a>` tag and surrounding `<div>` (lines 141-155) with:

```tsx
              {(() => {
                const downloadInfo = getViewerDownloadInfo();
                if (downloadInfo) {
                  return (
                    <div className="mt-2.5 flex items-center gap-3">
                      <a
                        href={downloadInfo.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download for {downloadInfo.os}
                      </a>
                      <button
                        onClick={() => setStatus('idle')}
                        className="text-xs text-muted-foreground transition hover:text-foreground"
                      >
                        Dismiss
                      </button>
                    </div>
                  );
                }
                return (
                  <div className="mt-2.5 space-y-2">
                    <div className="flex flex-col gap-1.5">
                      {getAllViewerDownloads().map((dl) => (
                        <a
                          key={dl.os}
                          href={dl.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700"
                        >
                          <Download className="h-3.5 w-3.5" />
                          {dl.os}
                        </a>
                      ))}
                    </div>
                    <button
                      onClick={() => setStatus('idle')}
                      className="text-xs text-muted-foreground transition hover:text-foreground"
                    >
                      Dismiss
                    </button>
                  </div>
                );
              })()}
```

**Step 3: Verify the build**

Run: `cd /Users/toddhebebrand/breeze && pnpm --filter @breeze/web build`
Expected: Build succeeds with no TypeScript errors

**Step 4: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/web/src/components/remote/ConnectDesktopButton.tsx
git commit -m "feat: wire OS-aware download button in remote viewer modal"
```

---

### Task 3: Update design doc with final implementation details

**Files:**
- Modify: `docs/plans/2026-02-13-viewer-download-design.md`

**Step 1: Update the design doc**

Update the "Unknown OS" behavior in the design doc to reflect the approved change: show all platform links instead of linking to GitHub releases page.

**Step 2: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add docs/plans/2026-02-13-viewer-download-design.md
git commit -m "docs: update design doc with all-platforms fallback"
```
