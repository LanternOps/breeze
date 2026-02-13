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

  it('has a valid fallback URL', () => {
    expect(VIEWER_DOWNLOADS_FALLBACK_URL).toMatch(/github\.com\/.*\/releases\/latest$/);
  });
});
