import { createContext, useContext, useEffect, useState, useMemo, type ReactNode } from 'react';
import { storageRemove, storageSet } from '@/lib/safe-storage';

/** Visual themes that map to actual CSS styling */
export type VisualTheme = 'lumina' | 'deepspace' | 'clean';

/** User-selectable appearance preference (includes "auto" which follows system) */
export type Theme = VisualTheme | 'auto';

interface ThemeContextType {
  /** The user's stored preference (may be "auto") */
  theme: Theme;
  /** The actually-applied visual theme (never "auto") */
  resolvedTheme: VisualTheme;
  setTheme: (theme: Theme) => void;
}

const STORAGE_KEY = 'appearance';
const VALID_THEMES: Theme[] = ['lumina', 'deepspace', 'clean', 'auto'];

function getInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && VALID_THEMES.includes(saved as Theme)) {
      return saved as Theme;
    }
    const legacy = localStorage.getItem('komari-theme');
    if (legacy === 'night') {
      return 'deepspace';
    }
  } catch {
    // localStorage not available
  }
  return 'clean';
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false,
  );

  // Listen for system color-scheme changes (only relevant when theme === 'auto')
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const resolvedTheme: VisualTheme = useMemo(() => {
    if (theme === 'auto') {
      return systemDark ? 'deepspace' : 'lumina';
    }
    return theme;
  }, [theme, systemDark]);

  useEffect(() => {
    const root = document.documentElement;

    // Clear old attributes
    root.removeAttribute('data-theme');
    root.classList.remove('dark');

    if (resolvedTheme === 'deepspace') {
      root.setAttribute('data-theme', 'deepspace');
      root.classList.add('dark');
    } else if (resolvedTheme === 'clean') {
      root.setAttribute('data-theme', 'clean');
    }
    // lumina uses default :root, no attribute needed

    // Sync <meta name="theme-color"> so the PWA standalone-mode status bar
    // (and Android title bar / iOS Safari tab) tracks the active theme.
    // Values mirror the --background oklch tokens defined in index.css,
    // converted to sRGB for the meta tag (which only accepts hex/rgb).
    const themeColor =
      resolvedTheme === 'deepspace' ? '#0a0e1a' :
      resolvedTheme === 'clean'     ? '#fcfcfd' :
      /* lumina */                    '#eff5f6';
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', themeColor);

    /**
     * 标签页图标：**不在这里改**。
     * hub 1.4.0 起由面板「设置 → 站点图标」管 —— 站长设了就用它，没设时按
     * index.html 里那两个固定地址回落到主题自带的 `public/favicon.svg` /
     * `public/apple-touch-icon.png`（hub 会给地址带上内容版本号）。
     * 旧版本这里会把所有 `<link rel="icon">` 改写成 Commander 字标的 data URI，
     * 那样站长换的站点图标永远出不来 —— 随 hub 1.4.x 适配一并移除。
     */

    // Persist preference（浏览器禁用站点数据时写入会抛 SecurityError，走安全封装）
    storageSet(STORAGE_KEY, theme);

    storageRemove('komari-theme');
  }, [theme, resolvedTheme]);

  // Toggle a root attribute when the page is hidden so a global CSS rule
  // can pause all decorative animations (radar sweeps, label pulses,
  // queue bars, scanlines, etc.). Browsers throttle rAF when hidden but
  // CSS keyframes still advance their timelines and, on some platforms
  // (PiP, side-by-side, certain external displays), still trigger
  // composite work — this gives us a single, observable signal we can
  // hook from the stylesheet.
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      if (document.hidden) {
        root.setAttribute('data-page-hidden', '');
      } else {
        root.removeAttribute('data-page-hidden');
      }
    };
    apply();
    document.addEventListener('visibilitychange', apply);
    return () => document.removeEventListener('visibilitychange', apply);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
