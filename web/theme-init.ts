import { applyTheme, getTheme } from './lib/theme.js';

// Runs before the stylesheet to avoid flashing the wrong theme. Kept external for CSP.
applyTheme(getTheme());
