/**
 * Built-in desktop themes. Names match the CLI skins / dashboard presets.
 * Add new themes here — no code changes needed elsewhere.
 */

import type { DesktopTheme, DesktopThemeTypography } from './types'

// Color-emoji fonts to append to every stack as a last resort. None of the UI
// text/mono fonts carry emoji glyphs, so without this emoji render as tofu
// boxes on platforms whose default text font lacks them (e.g. Linux/#40364).
// Covers macOS, Windows, Linux, plus the `emoji` generic for anything else.
export const EMOJI_FALLBACK = '"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", emoji'

const SYSTEM_SANS =
  '"Segoe WPC", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif, ' +
  EMOJI_FALLBACK

const SYSTEM_MONO =
  '"Cascadia Code", "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace, ' + EMOJI_FALLBACK

export const DEFAULT_TYPOGRAPHY: DesktopThemeTypography = { fontSans: SYSTEM_SANS, fontMono: SYSTEM_MONO }

const NOUS_BLUE = '#0053FD'
const PSYCHE_BLUE = '#1540B1'
const PSYCHE_WARM = '#FFE6CB'

const nousTint = (pct: number) => `color-mix(in srgb, ${NOUS_BLUE} ${pct}%, #FFFFFF)`
const nousTintTransparent = (pct: number) => `color-mix(in srgb, ${NOUS_BLUE} ${pct}%, transparent)`

/**
 * Nous — canonical Alice desktop identity. The palette keeps the current
 * glass geometry neutral, then lets the old bb/gui blue and psyche cream
 * return as accent seeds.
 */
export const nousTheme: DesktopTheme = {
  name: 'nous',
  label: 'Nous',
  description: 'Rosé Pine Theme',
  colors: {
    background: '#faf4ed',
    foreground: '#575279',
    card: '#fffaf3',
    cardForeground: '#575279',
    muted: '#f2e9e1',
    mutedForeground: '#797593',
    popover: '#fffaf3',
    popoverForeground: '#575279',
    primary: '#286983',
    primaryForeground: '#fffaf3',
    secondary: '#f2e9e1',
    secondaryForeground: '#575279',
    accent: '#dfdad9',
    accentForeground: '#575279',
    border: '#dfdad9',
    input: '#dfdad9',
    ring: '#d7827e',
    midground: '#286983',
    composerRing: '#286983',
    destructive: '#b4637a',
    destructiveForeground: '#fffaf3',
    sidebarBackground: '#faf4ed',
    sidebarBorder: '#f2e9e1',
    userBubble: '#f2e9e1',
    userBubbleBorder: '#dfdad9'
  },
  darkColors: {
    background: '#232136',
    foreground: '#e0def4',
    card: '#2a273f',
    cardForeground: '#e0def4',
    muted: '#393552',
    mutedForeground: '#908caa',
    popover: '#2a273f',
    popoverForeground: '#e0def4',
    primary: '#3e8fb0',
    primaryForeground: '#2a273f',
    secondary: '#393552',
    secondaryForeground: '#e0def4',
    accent: '#44415a',
    accentForeground: '#e0def4',
    border: '#44415a',
    input: '#44415a',
    ring: '#ea9a97',
    midground: '#3e8fb0',
    composerRing: '#3e8fb0',
    destructive: '#eb6f92',
    destructiveForeground: '#232136',
    sidebarBackground: '#232136',
    sidebarBorder: '#393552',
    userBubble: '#393552',
    userBubbleBorder: '#44415a'
  },
  typography: {
    fontSans: SYSTEM_SANS,
    fontMono: `"Courier Prime", ${SYSTEM_MONO}`,
    fontUrl: 'https://fonts.googleapis.com/css2?family=Courier+Prime:wght@400;700&display=swap'
  }
}

/** Deep blue-violet with cool accents. Matches the dashboard midnight theme. */
export const midnightTheme: DesktopTheme = {
  name: 'midnight',
  label: 'Midnight',
  description: 'Deep blue-violet with cool accents',
  colors: {
    background: '#08081c',
    foreground: '#ddd6ff',
    card: '#0d0d28',
    cardForeground: '#ddd6ff',
    muted: '#13133a',
    mutedForeground: '#7c7ab0',
    popover: '#0f0f2e',
    popoverForeground: '#ddd6ff',
    primary: '#ddd6ff',
    primaryForeground: '#08081c',
    secondary: '#1a1a4a',
    secondaryForeground: '#c4bff0',
    accent: '#1a1a44',
    accentForeground: '#d0c8ff',
    border: '#1e1e52',
    input: '#1e1e52',
    ring: '#8b80e8',
    midground: '#8b80e8',
    destructive: '#b03060',
    destructiveForeground: '#fef2f2',
    sidebarBackground: '#06061a',
    sidebarBorder: '#12123a',
    userBubble: '#14143a',
    userBubbleBorder: '#242466'
  },
  typography: {
    fontMono: `"JetBrains Mono", ${SYSTEM_MONO}`,
    fontUrl: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap'
  }
}

/** Warm crimson and bronze — forge vibes. Matches the CLI ares skin. */
export const emberTheme: DesktopTheme = {
  name: 'ember',
  label: 'Ember',
  description: 'Warm crimson and bronze — forge vibes',
  colors: {
    background: '#160800',
    foreground: '#ffd8b0',
    card: '#1e0e04',
    cardForeground: '#ffd8b0',
    muted: '#2a1408',
    mutedForeground: '#aa7a56',
    popover: '#221008',
    popoverForeground: '#ffd8b0',
    primary: '#ffd8b0',
    primaryForeground: '#160800',
    secondary: '#341800',
    secondaryForeground: '#f0c090',
    accent: '#301600',
    accentForeground: '#e8c080',
    border: '#3a1c08',
    input: '#3a1c08',
    ring: '#d97316',
    midground: '#d97316',
    destructive: '#c43010',
    destructiveForeground: '#fef2f2',
    sidebarBackground: '#100600',
    sidebarBorder: '#2a1004',
    userBubble: '#2a1000',
    userBubbleBorder: '#4a2010'
  },
  typography: {
    fontMono: `"IBM Plex Mono", ${SYSTEM_MONO}`,
    fontUrl: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;700&display=swap'
  }
}

/** Clean grayscale. Matches the CLI mono skin and dashboard mono theme. */
export const monoTheme: DesktopTheme = {
  name: 'mono',
  label: 'Mono',
  description: 'Clean grayscale — minimal and focused',
  colors: {
    background: '#0e0e0e',
    foreground: '#eaeaea',
    card: '#141414',
    cardForeground: '#eaeaea',
    muted: '#1e1e1e',
    mutedForeground: '#808080',
    popover: '#181818',
    popoverForeground: '#eaeaea',
    primary: '#eaeaea',
    primaryForeground: '#0e0e0e',
    secondary: '#262626',
    secondaryForeground: '#c8c8c8',
    accent: '#222222',
    accentForeground: '#d8d8d8',
    border: '#2a2a2a',
    input: '#2a2a2a',
    ring: '#9a9a9a',
    midground: '#9a9a9a',
    destructive: '#a84040',
    destructiveForeground: '#fef2f2',
    sidebarBackground: '#0a0a0a',
    sidebarBorder: '#202020',
    userBubble: '#1a1a1a',
    userBubbleBorder: '#363636'
  }
}

/** Neon green on black. Matches the CLI cyberpunk skin and dashboard theme. */
export const cyberpunkTheme: DesktopTheme = {
  name: 'cyberpunk',
  label: 'Cyberpunk',
  description: 'Neon green on black — matrix terminal',
  colors: {
    background: '#000a00',
    foreground: '#00ff41',
    card: '#001200',
    cardForeground: '#00ff41',
    muted: '#001a00',
    mutedForeground: '#1a8a30',
    popover: '#001000',
    popoverForeground: '#00ff41',
    primary: '#00ff41',
    primaryForeground: '#000a00',
    secondary: '#002800',
    secondaryForeground: '#00cc34',
    accent: '#002000',
    accentForeground: '#00e038',
    border: '#003000',
    input: '#003000',
    ring: '#00ff41',
    midground: '#00ff41',
    destructive: '#ff003c',
    destructiveForeground: '#000a00',
    sidebarBackground: '#000600',
    sidebarBorder: '#001800',
    userBubble: '#001400',
    userBubbleBorder: '#004800'
  },
  typography: {
    fontMono: `"Courier New", Courier, monospace, ${EMOJI_FALLBACK}`,
    fontSans: `"Courier New", Courier, monospace, ${EMOJI_FALLBACK}`
  }
}

/** Cool slate blue for developers. Matches the CLI slate skin. */
export const slateTheme: DesktopTheme = {
  name: 'slate',
  label: 'Slate',
  description: 'Cool slate blue — focused developer theme',
  colors: {
    background: '#0d1117',
    foreground: '#c9d1d9',
    card: '#161b22',
    cardForeground: '#c9d1d9',
    muted: '#21262d',
    mutedForeground: '#8b949e',
    popover: '#1c2128',
    popoverForeground: '#c9d1d9',
    primary: '#c9d1d9',
    primaryForeground: '#0d1117',
    secondary: '#2a3038',
    secondaryForeground: '#adb5bf',
    accent: '#1e2530',
    accentForeground: '#c0c8d0',
    border: '#30363d',
    input: '#30363d',
    ring: '#58a6ff',
    midground: '#58a6ff',
    destructive: '#cf4848',
    destructiveForeground: '#fef2f2',
    sidebarBackground: '#090d13',
    sidebarBorder: '#1c2228',
    userBubble: '#1e2a38',
    userBubbleBorder: '#2e4060'
  },
  typography: {
    fontMono: `"JetBrains Mono", ${SYSTEM_MONO}`
  }
}

/**
 * Alice's Descent — Victorian card-deck gothic dark aesthetic.
 *
 *   ♠ Spade   → Teal (pine)    #3a8c8c
 *   ♥ Heart   → Carmesí (love) #a8213a
 *   ♦ Diamond → Teal (foam)    #4fa8a8
 *   ♣ Club    → Gold (tarnished) #b8864e
 *
 * Light mode: warm parchment/cream foundation with the same suit accents.
 * Dark mode (primary): deep gothic purple-black with crema/parchment text.
 */
export const aliceTheme: DesktopTheme = {
  name: 'alice',
  label: "Alice's Descent",
  description: 'Victorian card-deck gothic dark — ♠♥♦♣',

  colors: {
    background: '#f5f0e8',
    foreground: '#2a2438',
    card: '#faf6ee',
    cardForeground: '#2a2438',
    muted: '#ece6da',
    mutedForeground: '#6e687c',
    popover: '#ffffff',
    popoverForeground: '#2a2438',
    primary: '#c45a6b',
    primaryForeground: '#ffffff',
    secondary: '#e8e0d4',
    secondaryForeground: '#4a4458',
    accent: '#ede4d6',
    accentForeground: '#2a2438',
    border: '#d4ccc0',
    input: '#d4ccc0',
    ring: '#b8864e',
    midground: '#7848a0',
    destructive: '#a8213a',
    destructiveForeground: '#ffffff',
    sidebarBackground: '#f0ebe0',
    sidebarBorder: '#d4ccc0',
    userBubble: '#ece6da',
    userBubbleBorder: '#d4ccc0'
  },

  darkColors: {
    background: '#0c0a12',
    foreground: '#d4cfc7',
    card: '#16131f',
    cardForeground: '#d4cfc7',
    muted: '#191622',
    mutedForeground: '#6e687c',
    popover: '#221e30',
    popoverForeground: '#d4cfc7',
    primary: '#c45a6b',
    primaryForeground: '#0c0a12',
    secondary: '#2d2940',
    secondaryForeground: '#958da5',
    accent: '#2d2940',
    accentForeground: '#d4cfc7',
    border: '#413d57',
    input: '#2d2940',
    ring: '#b8864e',
    midground: '#7848a0',
    destructive: '#a8213a',
    destructiveForeground: '#d4cfc7',
    sidebarBackground: '#0c0a12',
    sidebarBorder: '#2d2940',
    userBubble: '#16131f',
    userBubbleBorder: '#2d2940'
  },

  typography: {
    fontSans:
      '"Inter", "Segoe WPC", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif, ' +
      EMOJI_FALLBACK,
    fontUrl:
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Cinzel:wght@400;600;700&family=Grenze+Gotisch:wght@700&display=swap'
  }
}

export const BUILTIN_THEMES: Record<string, DesktopTheme> = {
  nous: nousTheme,
  midnight: midnightTheme,
  ember: emberTheme,
  mono: monoTheme,
  cyberpunk: cyberpunkTheme,
  slate: slateTheme,
  alice: aliceTheme
}

export const BUILTIN_THEME_LIST = Object.values(BUILTIN_THEMES)

/** Skin used when nothing is persisted or the persisted name is retired. */
export const DEFAULT_SKIN_NAME = 'nous'
