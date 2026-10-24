// Light and dark mode, copied from maushook.com so the two feel like one site. The app shares that
// origin, so it also shares the storage key: a choice made on either site carries over to the other.
// Dark is the default; with no stored choice, a system light preference wins, as on maushook.com.
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';

type Theme = 'dark' | 'light';
const KEY = 'maushook-theme';
const BG: Record<Theme, string> = { dark: '#121210', light: '#f5f4ef' };
const prefersLight = window.matchMedia('(prefers-color-scheme: light)');

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}
const current = (): Theme => stored() ?? (prefersLight.matches ? 'light' : 'dark');

function apply(theme: Theme, button: HTMLButtonElement) {
  document.documentElement.dataset.theme = theme;
  const other = theme === 'dark' ? 'light' : 'dark';
  button.textContent = `${other} mode`;
  button.setAttribute('aria-label', `Switch to ${other} mode`);
  button.setAttribute('aria-pressed', String(theme === 'light'));
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', BG[theme]));
}

// Wires a toggle button. Returns a cleanup so React effects can unbind it.
export function bindThemeToggle(button: HTMLButtonElement) {
  apply(current(), button);
  const onClick = () => {
    const next: Theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(KEY, next); } catch { /* storage blocked: the choice lasts for this page only */ }
    apply(next, button);
  };
  const onSystem = () => { if (!stored()) apply(current(), button); };
  button.addEventListener('click', onClick);
  prefersLight.addEventListener('change', onSystem);
  return () => {
    button.removeEventListener('click', onClick);
    prefersLight.removeEventListener('change', onSystem);
  };
}
