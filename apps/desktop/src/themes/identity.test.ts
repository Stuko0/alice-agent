import { describe, expect, it } from 'vitest'

import { contrastRatio } from './color'
import { BUILTIN_THEMES, DEFAULT_SKIN_NAME, madnessTheme } from './presets'
import type { DesktopTheme, DesktopThemeColors } from './types'

// Alice visual identity contract. These are relationships (contrast, completeness,
// default), not snapshots of the palette: re-tuning the colors is fine as long as
// the identity stays readable and consistent.

const COLOR_KEYS: (keyof DesktopThemeColors)[] = [
  'background',
  'foreground',
  'card',
  'cardForeground',
  'muted',
  'mutedForeground',
  'popover',
  'popoverForeground',
  'primary',
  'primaryForeground',
  'secondary',
  'secondaryForeground',
  'accent',
  'accentForeground',
  'border',
  'input',
  'ring',
  'destructive',
  'destructiveForeground',
  'sidebarBackground',
  'sidebarBorder',
  'userBubble',
  'userBubbleBorder'
]

function swatches(theme: DesktopTheme): Array<{ mode: string; colors: DesktopThemeColors }> {
  return [
    { colors: theme.colors, mode: 'light' },
    ...(theme.darkColors ? [{ colors: theme.darkColors, mode: 'dark' }] : [])
  ]
}

const AA = 4.5
const AA_LARGE = 3

describe('Alice identity theme', () => {
  it('is the default skin', () => {
    expect(DEFAULT_SKIN_NAME).toBe('madness')
    expect(BUILTIN_THEMES[DEFAULT_SKIN_NAME]).toBeDefined()
  })

  it('has no Nous theme left in the registry', () => {
    expect(Object.keys(BUILTIN_THEMES)).not.toContain('nous')
  })

  it('defines every color token in light and dark (no undefined seeds)', () => {
    for (const { colors, mode } of swatches(madnessTheme)) {
      const missing = COLOR_KEYS.filter(key => !colors[key])

      expect(missing, `${mode} is missing ${missing.join(', ')}`).toEqual([])
    }
  })

  it('keeps body text and accents readable in both modes', () => {
    for (const { colors, mode } of swatches(madnessTheme)) {
      const pairs: Array<[string, string, string]> = [
        ['foreground/background', colors.foreground, colors.background],
        ['foreground/card', colors.foreground, colors.card],
        ['mutedForeground/card', colors.mutedForeground, colors.card],
        ['mutedForeground/background', colors.mutedForeground, colors.background],
        ['primaryForeground/primary', colors.primaryForeground, colors.primary],
        ['sidebarForeground-ish/background', colors.foreground, colors.sidebarBackground ?? colors.background]
      ]

      for (const [label, fg, bg] of pairs) {
        expect(contrastRatio(fg, bg), `${mode}: ${label}`).toBeGreaterThanOrEqual(AA)
      }

      // Focus ring: needs to be visible against both the canvas and a control.
      expect(contrastRatio(colors.ring, colors.background), `${mode}: ring/background`).toBeGreaterThanOrEqual(AA_LARGE)
      expect(contrastRatio(colors.ring, colors.card), `${mode}: ring/card`).toBeGreaterThanOrEqual(AA_LARGE)
    }
  })

  it('keeps destructive readable on its own foreground', () => {
    for (const { colors, mode } of swatches(madnessTheme)) {
      expect(contrastRatio(colors.destructiveForeground, colors.destructive), `${mode}: destructive`).toBeGreaterThanOrEqual(
        AA
      )
    }
  })
})
