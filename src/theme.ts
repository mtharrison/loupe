export type ThemeMode = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'llm-trace-theme';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark';
}

export function resolvePreferredTheme(): ThemeMode {
  const documentRef = getDocument();
  if (documentRef) {
    const theme = documentRef.documentElement?.dataset?.theme;
    if (isThemeMode(theme)) {
      return theme;
    }
  }

  const windowRef = getWindow();
  if (windowRef) {
    try {
      const stored = windowRef.localStorage?.getItem(THEME_STORAGE_KEY);
      if (isThemeMode(stored)) {
        return stored;
      }
    } catch (_error) {
      // Ignore storage errors and fall back to system preference.
    }

    if (windowRef.matchMedia?.('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  }

  return 'light';
}

export function applyTheme(theme: ThemeMode) {
  const documentRef = getDocument();
  if (documentRef) {
    documentRef.documentElement.dataset.theme = theme;
    documentRef.documentElement.style.colorScheme = theme;
  }

  const windowRef = getWindow();
  if (windowRef) {
    try {
      windowRef.localStorage?.setItem(THEME_STORAGE_KEY, theme);
    } catch (_error) {
      // Ignore storage errors in local dev.
    }
  }
}

export function renderThemeBootstrapScript(): string {
  return `(function(){try{var key=${JSON.stringify(THEME_STORAGE_KEY)};var stored=localStorage.getItem(key);var theme=(stored==='light'||stored==='dark')?stored:((window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light');document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;}catch(_err){document.documentElement.dataset.theme='light';document.documentElement.style.colorScheme='light';}})();`;
}

function getWindow(): { localStorage?: any; matchMedia?: (query: string) => any } | null {
  if (typeof globalThis !== 'object' || !('window' in globalThis)) {
    return null;
  }

  return (globalThis as { window?: { localStorage?: any; matchMedia?: (query: string) => any } }).window ?? null;
}

function getDocument(): { documentElement: { dataset: Record<string, string | undefined>; style: { colorScheme: string } } } | null {
  if (typeof globalThis !== 'object' || !('document' in globalThis)) {
    return null;
  }

  return (globalThis as {
    document?: { documentElement: { dataset: Record<string, string | undefined>; style: { colorScheme: string } } };
  }).document ?? null;
}
