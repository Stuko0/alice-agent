import { afterEach, describe, expect, it } from 'vitest'

import { browserSurfaceVisible, OVERLAY_SELECTOR, surfaceLayerPresent } from './browser-surface'

// The native page is a GTK widget above the DOM: it may only stay on screen
// while nothing else is painted over its rect (dialogs, menus, palette).
describe('browserSurfaceVisible', () => {
  const cases: Array<[string, Parameters<typeof browserSurfaceVisible>[0], boolean]> = [
    ['drawer closed', { baseVisible: false, overlays: false }, false],
    ['drawer open, nothing over it', { baseVisible: true, overlays: false }, true],
    ['dialog/menu/palette on screen', { baseVisible: true, overlays: true }, false],
    ['drawer closed behind a layer', { baseVisible: false, overlays: true }, false]
  ]

  for (const [label, input, expected] of cases) {
    it(label, () => {
      expect(browserSurfaceVisible(input)).toBe(expected)
    })
  }
})

describe('surfaceLayerPresent', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const mount = (html: string) => {
    document.body.insertAdjacentHTML('beforeend', html)
  }

  it('sees an open dialog/menu/popover', () => {
    mount('<div data-slot="dialog-content" data-state="open"></div>')
    expect(surfaceLayerPresent()).toBe(true)
  })

  it('ignores closed content', () => {
    mount('<div data-slot="dropdown-menu-content" data-state="closed"></div>')
    expect(surfaceLayerPresent()).toBe(false)
  })

  it('ignores tooltips (they hover over everything)', () => {
    mount('<div data-slot="tooltip-content" data-state="open"></div>')
    expect(surfaceLayerPresent()).toBe(false)
  })

  it('sees the custom palette/switcher/onboarding marker', () => {
    mount('<div data-surface-layer="open"></div>')
    expect(surfaceLayerPresent()).toBe(true)
  })

  it('matches the selector it advertises', () => {
    expect(OVERLAY_SELECTOR).toContain('dialog-content')
    expect(OVERLAY_SELECTOR).not.toContain('tooltip')
  })
})
