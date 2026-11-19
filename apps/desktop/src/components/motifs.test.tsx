import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { KeyholeMark, SuitDivider, SuitMark } from './motifs'

afterEach(cleanup)

describe('decorative motifs', () => {
  it('renders each suit as an aria-hidden, non-interactive glyph', () => {
    for (const [suit, glyph] of [
      ['spade', '♠'],
      ['heart', '♥'],
      ['diamond', '♦'],
      ['club', '♣']
    ] as const) {
      const { container } = render(<SuitMark suit={suit} />)
      const mark = container.querySelector('[data-motif]')

      expect(mark?.textContent).toBe(glyph)
      expect(mark?.getAttribute('aria-hidden')).toBe('true')
      expect(mark?.className).toContain('pointer-events-none')
      expect(mark?.className).toContain('select-none')
    }
  })

  it('never animates a motif', () => {
    const { container } = render(
      <>
        <SuitMark suit="heart" />
        <SuitDivider />
        <KeyholeMark />
      </>
    )

    for (const node of container.querySelectorAll('[aria-hidden], [data-motif], [data-slot]')) {
      expect(node.getAttribute('class') ?? '').not.toMatch(/animate|transition/)
    }
  })

  it('renders the four-suit footer divider in order', () => {
    const { container } = render(<SuitDivider />)
    const divider = container.querySelector('[data-slot="suit-divider"]')

    expect(divider).not.toBeNull()
    const glyphs = [...(divider?.querySelectorAll('[data-motif]') ?? [])].map(node => node.textContent)
    expect(glyphs).toEqual(['♠', '♥', '♦', '♣'])
    expect(divider?.className).toContain('pointer-events-none')
  })

  it('renders the keyhole empty-state mark as decorative SVG', () => {
    const { container } = render(<KeyholeMark />)
    const svg = container.querySelector('svg[data-slot="keyhole"]')

    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })
})
