---
tracking_issue: null
---
# Fix Viewer Idle Update Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Breeze Viewer users are prompted with the update indicator banner ("Restart & update") when the app is in the idle standby state (`windowLabel === 'main'`).

**Root Cause:**
In `apps/viewer/src/App.tsx`, when `windowLabel === 'main'`, the view renders the standby splash ("Breeze Viewer is ready") or scheme error screen directly, omitting `<UpdateIndicator />`. The Tauri background updater checks for updates and emits `update-status` events (e.g. `UpdateStatus::Ready { version }`), but because the component is unmounted, the update prompt is invisible to the user until a remote session is opened.

**Architecture:**
Wrap the idle screen returns in `apps/viewer/src/App.tsx` (`windowLabel === 'main'`) with `<UpdateIndicator />`. Because `<UpdateIndicator />` returns `null` when no update is active or pending, it has zero impact on layout during normal standby, and gracefully floats at the top of the window when an update is downloaded and ready to apply.

## Proposed Changes

### apps/viewer/src/App.tsx
- [x] Mount `<UpdateIndicator />` above both standby branches (`schemeError` and default ready screen) when `windowLabel === 'main'`.

### apps/viewer/src/App.updateIndicator.test.ts
- [x] Add unit test verifying `<UpdateIndicator />` is mounted in the main standby window.
