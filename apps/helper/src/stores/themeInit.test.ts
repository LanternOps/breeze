// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { initTheme, setTheme } from '../lib/theme';

describe('theme init', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to light (no data-theme attribute)', () => {
    initTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('applies persisted dark theme', () => {
    localStorage.setItem('ws-theme', 'dark');
    initTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('setTheme persists and applies', () => {
    setTheme('dark');
    expect(localStorage.getItem('ws-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    setTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });
});
