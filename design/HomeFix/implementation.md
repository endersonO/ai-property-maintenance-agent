# Implementation

Next.js 16 + Tailwind CSS 4, plain CSS custom properties, no component library. Paste into `app/globals.css`. Every colour is a light/dark pair resolved by `light-dark()` from the system preference.

## Fonts

```ts
// app/layout.tsx
import { Geist, Geist_Mono } from "next/font/google";
const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
// <html lang="en-GB" className={`${sans.variable} ${mono.variable}`}>
```

## globals.css

```css
@import "tailwindcss";

:root {
  color-scheme: light dark;

  --background: light-dark(#f6f7f5, #0f1211);
  --surface: light-dark(#ffffff, #181c1b);
  --subtle: light-dark(#eef1ef, #212624);
  --foreground: light-dark(#17201d, #e7ecea);
  --muted: light-dark(#56625e, #9ba7a3);
  --border: light-dark(#dce1de, #2c3330);
  --border-strong: light-dark(#7f8b87, #6a7672);
  --accent: light-dark(#0d6a5b, #5ec6b0);
  --accent-hover: light-dark(#0a5649, #7dd5c2);
  --accent-text: light-dark(#ffffff, #06231d);
  --accent-soft: light-dark(#e3f2ee, #16302b);
  --priority-emergency: light-dark(#b3261e, #ff8f80);
  --priority-emergency-soft: light-dark(#fdeceb, #3b1916);
  --priority-high: light-dark(#a14a00, #f3a65e);
  --priority-high-soft: light-dark(#fdf0e2, #352410);
  --priority-normal: light-dark(#2b5c8a, #8fbbe8);
  --priority-normal-soft: light-dark(#e7eff8, #18263a);
  --priority-low: light-dark(#55615d, #a3aeaa);
  --priority-low-soft: light-dark(#edf0ee, #242a28);
  --status-ok: light-dark(#1c6f38, #6fd08e);
  --status-ok-soft: light-dark(#e5f4e9, #16301f);
  --status-rejected: light-dark(#7a5a00, #e2bb55);
  --status-rejected-soft: light-dark(#fbf3dc, #2f2710);
  --status-error: light-dark(#b3261e, #ff8f80);
  --status-error-soft: light-dark(#fdeceb, #3b1916);
  --review: light-dark(#7b3f98, #d6a9ee);
  --review-soft: light-dark(#f5ebfa, #2e1d37);

  --elevation-sm: 0 1px 2px rgb(16 24 22 / 0.06);
  --elevation-md: 0 4px 16px rgb(16 24 22 / 0.10);
}
@media (prefers-color-scheme: dark) {
  :root {
    --elevation-sm: 0 1px 2px rgb(0 0 0 / 0.5);
    --elevation-md: 0 6px 20px rgb(0 0 0 / 0.55);
  }
}
```

`light-dark()` takes colours only, so the two shadows switch with a media query. They are named `--elevation-*` here (tokens `shadow-sm` / `shadow-md`) so they don't collide with Tailwind's own `--shadow-*` theme variables.

## Tailwind 4 @theme

```css
@theme inline {
  --font-sans: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-geist-mono), ui-monospace, monospace;

  --color-background: var(--background);
  --color-surface: var(--surface);
  --color-subtle: var(--subtle);
  --color-foreground: var(--foreground);
  --color-muted: var(--muted);
  --color-border: var(--border);
  --color-border-strong: var(--border-strong);
  --color-accent: var(--accent);
  --color-accent-hover: var(--accent-hover);
  --color-accent-text: var(--accent-text);
  --color-accent-soft: var(--accent-soft);
  --color-emergency: var(--priority-emergency);
  --color-emergency-soft: var(--priority-emergency-soft);
  --color-high: var(--priority-high);
  --color-high-soft: var(--priority-high-soft);
  --color-normal: var(--priority-normal);
  --color-normal-soft: var(--priority-normal-soft);
  --color-low: var(--priority-low);
  --color-low-soft: var(--priority-low-soft);
  --color-ok: var(--status-ok);
  --color-ok-soft: var(--status-ok-soft);
  --color-rejected: var(--status-rejected);
  --color-rejected-soft: var(--status-rejected-soft);
  --color-error: var(--status-error);
  --color-error-soft: var(--status-error-soft);
  --color-review: var(--review);
  --color-review-soft: var(--review-soft);

  --text-title-lg: 24px;  --text-title-lg--line-height: 32px;
  --text-title: 18px;     --text-title--line-height: 26px;
  --text-heading: 15px;   --text-heading--line-height: 22px;
  --text-body-lg: 16px;   --text-body-lg--line-height: 24px;
  --text-body: 14px;      --text-body--line-height: 20px;
  --text-body-sm: 13px;   --text-body-sm--line-height: 18px;
  --text-label: 12px;     --text-label--line-height: 16px;

  --radius-sm: 4px; --radius-md: 6px; --radius-lg: 10px; --radius-xl: 16px;
  --shadow-panel: var(--elevation-sm); --shadow-float: var(--elevation-md);
}

body { background: var(--background); color: var(--foreground); font-family: var(--font-sans); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
```

Usage: `bg-surface text-foreground border-border`, `bg-emergency-soft text-emergency`, `bg-accent text-accent-text hover:bg-accent-hover`, `text-body-sm text-muted`, `shadow-panel`. Spacing uses Tailwind's default 4px scale (`p-4` = `space-4`).

## Formatting helpers

```ts
export const fmtDate = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
export const fmtGBP = (n: number, digits = 2) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
```
