export type Theme = 'light' | 'dark' | 'system';

export function getTheme(): Theme {
  try {
    const value = localStorage.getItem('pinotator.theme');
    if (value === 'light' || value === 'dark') return value;
  } catch {
    /* Storage is optional. */
  }
  return 'system';
}

export function applyTheme(theme: Theme) {
  const dark =
    theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#171717' : '#fafafa');
}
