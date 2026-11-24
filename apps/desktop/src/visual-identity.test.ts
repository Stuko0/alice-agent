import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { madnessTheme } from './themes/presets'

// Visual-identity guardrails: the "Madness" look must stay flat and cheap.
// These assert structure (no glow ring, no photo backdrop, bounded texture),
// never a specific color value.

const ROOT = import.meta.dirname
const styles = readFileSync(join(ROOT, 'styles.css'), 'utf8')
const backdrop = readFileSync(join(ROOT, 'components/Backdrop.tsx'), 'utf8')
const sidebar = readFileSync(join(ROOT, 'app/chat/sidebar/index.tsx'), 'utf8')
const sectionStates = readFileSync(join(ROOT, 'app/chat/sidebar/section-states.tsx'), 'utf8')
const sessionsSection = readFileSync(join(ROOT, 'app/chat/sidebar/sessions-section.tsx'), 'utf8')
const cronSection = readFileSync(join(ROOT, 'app/chat/sidebar/cron-jobs-section.tsx'), 'utf8')

describe('visual identity invariants', () => {
  it('carries no Nous design-system traces', () => {
    expect(styles.toLowerCase()).not.toContain('nous')
    expect(styles).not.toContain('Collapse')
    expect(styles).not.toContain('arc-border')
    expect(styles).not.toContain('arc-nous')
  })

  it('never uses a bitmap backdrop', () => {
    expect(backdrop).not.toContain('url(')
    expect(backdrop).not.toContain('<img')
    expect(backdrop).not.toContain('filler-bg')
    expect(backdrop).not.toContain('leva')
  })

  it('bounds the ink texture at or below 8% opacity', () => {
    const block = styles.slice(styles.indexOf('.texture-veil'), styles.indexOf('}', styles.indexOf('.texture-veil')))
    const percentages = [...block.matchAll(/(\d+(?:\.\d+)?)%/g)].map(match => Number(match[1]))

    expect(percentages.length).toBeGreaterThan(0)
    for (const value of percentages) {
      expect(value).toBeLessThanOrEqual(8)
    }
  })

  it('keeps a display font for the wordmark with an offline fallback', () => {
    expect(styles).toContain('--font-display')
    expect(styles).toContain("'Cinzel'")
    expect(styles).toContain("'Grenze Gotisch'")
    expect(madnessTheme.typography?.fontUrl ?? '').toContain('Cinzel')
    // The wordmark must use the shared display stack, not a hardcoded inline
    // face — that is what kept Cinzel from ever rendering.
    const intro = readFileSync(join(ROOT, 'components/chat/intro.tsx'), 'utf8')
    expect(intro).toContain('[font-family:var(--font-display)]')
    expect(intro).not.toContain("fontFamily: \"'Grenze Gotisch'\"")
  })

  it('threads the card-suit motifs through the sidebar', () => {
    // One suit per section, a keyhole for empty states, and a suit divider in
    // the footer — all aria-hidden by the components themselves.
    expect(sessionsSection).toContain('motif?: Suit')
    expect(sessionsSection).toContain('motif={motif}')
    expect(sidebar).toContain('motif="diamond"')
    expect(sidebar).toContain('motif="heart"')
    expect(sidebar).toContain('motif="spade"')
    expect(sidebar).toContain('<SuitDivider')
    expect(cronSection).toContain('motif="club"')
    expect(sectionStates).toContain('<KeyholeMark')
  })

  it('bundles Cinzel locally so the wordmark survives offline', () => {
    expect(styles).toContain("url('/fonts/Cinzel-Variable.woff2')")
    const font = readFileSync(join(ROOT, '../public/fonts/Cinzel-Variable.woff2'))
    expect(font.byteLength).toBeGreaterThan(10_000)
  })

  it('keeps the identity surfaces still (no animation, no glow)', () => {
    // The Nous ring was an infinite gradient; the backdrop is a still hatch.
    expect(styles).not.toMatch(/arc-border|arc-nous|arc-reverse/)

    const veil = styles.slice(styles.indexOf('.texture-veil'), styles.indexOf('}', styles.indexOf('.texture-veil')))

    expect(veil).not.toContain('animation')
    expect(backdrop).not.toMatch(/animate|transition/)
  })
})
