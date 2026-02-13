import { describe, it, expect, vi, afterEach } from 'vitest';
import { getViewerDownloadInfo, getAllViewerDownloads } from './viewerDownload';

describe('getViewerDownloadInfo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns macOS info for Mac platform', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'macOS' }, platform: '', userAgent: '' });
    const info = getViewerDownloadInfo();
    expect(info).not.toBeNull();
    expect(info!.os).toBe('macos');
    expect(info!.label).toBe('macOS');
    expect(info!.filename).toBe('breeze-viewer-macos.dmg');
    expect(info!.url).toContain('breeze-viewer-macos.dmg');
  });

  it('returns Windows info for Windows platform', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'Windows' }, platform: '', userAgent: '' });
    const info = getViewerDownloadInfo();
    expect(info).not.toBeNull();
    expect(info!.os).toBe('windows');
    expect(info!.label).toBe('Windows');
    expect(info!.filename).toBe('breeze-viewer-windows.msi');
    expect(info!.url).toContain('breeze-viewer-windows.msi');
  });

  it('returns Linux info for Linux platform', () => {
    vi.stubGlobal('navigator', { userAgentData: undefined, platform: 'Linux x86_64', userAgent: '' });
    const info = getViewerDownloadInfo();
    expect(info).not.toBeNull();
    expect(info!.os).toBe('linux');
    expect(info!.label).toBe('Linux');
    expect(info!.filename).toBe('breeze-viewer-linux.AppImage');
    expect(info!.url).toContain('breeze-viewer-linux.AppImage');
  });

  it('falls back to navigator.platform when userAgentData unavailable', () => {
    vi.stubGlobal('navigator', { userAgentData: undefined, platform: 'MacIntel', userAgent: '' });
    const info = getViewerDownloadInfo();
    expect(info).not.toBeNull();
    expect(info!.os).toBe('macos');
  });

  it('falls through userAgentData to navigator.platform when platform is unrecognized', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'ChromeOS' }, platform: 'Win32', userAgent: '' });
    const info = getViewerDownloadInfo();
    expect(info).not.toBeNull();
    expect(info!.os).toBe('windows');
  });

  it('falls back to navigator.userAgent as last resort', () => {
    vi.stubGlobal('navigator', { userAgentData: undefined, platform: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    const info = getViewerDownloadInfo();
    expect(info).not.toBeNull();
    expect(info!.os).toBe('windows');
  });

  it('returns null for unknown OS', () => {
    vi.stubGlobal('navigator', { userAgentData: undefined, platform: 'UnknownOS', userAgent: 'SomeBot/1.0' });
    const info = getViewerDownloadInfo();
    expect(info).toBeNull();
  });

  it('returns null gracefully when navigator throws', () => {
    vi.stubGlobal('navigator', { get userAgentData() { throw new Error('blocked'); }, platform: '', userAgent: '' });
    const info = getViewerDownloadInfo();
    expect(info).toBeNull();
  });
});

describe('getAllViewerDownloads', () => {
  it('returns entries for all three platforms', () => {
    const all = getAllViewerDownloads();
    expect(all).toHaveLength(3);
    const osValues = all.map(d => d.os);
    expect(osValues).toContain('macos');
    expect(osValues).toContain('windows');
    expect(osValues).toContain('linux');
  });

  it('each entry has correct structure and GitHub release URL', () => {
    const all = getAllViewerDownloads();
    for (const entry of all) {
      expect(entry.os).toBeTruthy();
      expect(entry.label).toBeTruthy();
      expect(entry.filename).toBeTruthy();
      expect(entry.url).toMatch(/^https:\/\/github\.com\/toddhebebrand\/breeze\/releases\/latest\/download\//);
    }
  });
});
