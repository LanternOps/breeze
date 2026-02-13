# Viewer Download — OS-Aware Direct Download

## Problem

The "Download" button in the `ConnectDesktopButton` fallback modal (`href="#"`) does nothing. When a user clicks "Connect Desktop" and the Breeze Viewer app isn't installed, they see a modal prompting download but have no way to actually get the viewer.

## Decision

**Approach A: Inline utility in web app.** A small OS detection + URL construction utility used directly by the existing modal. No new API endpoints, pages, or shared packages.

## Design

### 1. OS Detection Utility

**File:** `apps/web/src/lib/viewerDownload.ts`

`getViewerDownloadInfo()` returns `{ os: string, url: string, filename: string } | null`:

- Uses `navigator.userAgentData?.platform` (modern) with `navigator.platform` / `navigator.userAgent` fallback
- Supported platforms:
  - macOS → `breeze-viewer-macos.dmg`
  - Windows → `breeze-viewer-windows.msi`
  - Linux → `breeze-viewer-linux.AppImage`
- Returns `null` for unknown OS

### 2. Download URL Construction

Uses GitHub's deterministic release asset URL pattern:

```
https://github.com/{owner}/{repo}/releases/latest/download/{filename}
```

- Base repo hardcoded default (`toddhebebrand/breeze`)
- No API calls or version resolution — GitHub `/releases/latest/download/` redirects automatically

### 3. Modal UX Changes

In `ConnectDesktopButton.tsx` fallback modal:

- Download button `href` wired to detected platform URL
- Button text shows detected OS: "Download for macOS" / "Download for Windows" / "Download for Linux"
- Unknown OS: shows download buttons for all three platforms (macOS, Windows, Linux) stacked vertically
- No other modal changes — existing warning text, icon, dismiss button, styling preserved

## Scope

- `apps/web/src/lib/viewerDownload.ts` — new file (~30 lines)
- `apps/web/src/components/remote/ConnectDesktopButton.tsx` — update download button
- No backend changes
- Viewer CI build job is a separate future PR

## Out of Scope

- Tauri viewer build pipeline (separate PR)
- Auto-update mechanism for the viewer
- Dedicated `/downloads` page (can extract utility later if needed)
