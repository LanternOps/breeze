export type WsTheme = 'light' | 'dark';
const KEY = 'ws-theme';

export function setTheme(theme: WsTheme): void {
  localStorage.setItem(KEY, theme);
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
}

export function initTheme(): void {
  const stored = localStorage.getItem(KEY);
  if (stored === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
}
