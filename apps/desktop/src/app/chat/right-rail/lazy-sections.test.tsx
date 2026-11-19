import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LazySections, splitMarkdownSections } from './lazy-sections'

interface ObserverHarness {
  callback: IntersectionObserverCallback
  observed: Element[]
}

let harness: ObserverHarness | null = null

class FakeIntersectionObserver {
  private callback: IntersectionObserverCallback
  private observed: Element[] = []

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    harness = { callback, observed: this.observed }
  }

  observe(element: Element) {
    this.observed.push(element)
  }

  disconnect() {
    this.observed = []
  }

  unobserve() {}
  takeRecords() {
    return []
  }
}

function intersect(index: number) {
  const target = harness?.observed.find(element => element.getAttribute('data-section') === String(index))

  if (!target || !harness) {
    throw new Error(`section ${index} is not observed`)
  }

  harness.callback(
    [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
    {} as IntersectionObserver
  )
}

describe('splitMarkdownSections', () => {
  it('splits on top-level headings', () => {
    const sections = splitMarkdownSections('# Title\n\nintro\n\n## One\n\na\n\n## Two\n\nb')

    expect(sections).toHaveLength(3)
    expect(sections[1]).toContain('## One')
    expect(sections[2]).toContain('## Two')
  })

  it('ignores headings inside fenced code blocks', () => {
    const sections = splitMarkdownSections('## Real\n\n```md\n## inside a fence\n```\n\n## Also real\n\nbody')

    expect(sections).toHaveLength(2)
  })

  it('hard-splits a section larger than the char budget', () => {
    const huge = `## Giant\n\n${'x'.repeat(13_000)}`
    const sections = splitMarkdownSections(huge)

    expect(sections.length).toBeGreaterThan(1)
    expect(Math.max(...sections.map(section => section.length))).toBeLessThanOrEqual(6000)
  })

  it('returns nothing for empty text', () => {
    expect(splitMarkdownSections('')).toEqual([])
  })
})

describe('LazySections', () => {
  afterEach(() => {
    cleanup()
    harness = null
    vi.unstubAllGlobals()
  })

  const text = Array.from({ length: 30 }, (_, index) => `## Section ${index}\n\nbody ${index}`).join('\n\n')

  function setup() {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)

    const rendered: number[] = []

    const view = render(
      <LazySections
        renderSection={(_section, index) => {
          rendered.push(index)

          return <span data-rendered={index}>section {index}</span>
        }}
        text={text}
      />
    )

    return { rendered, view }
  }

  it('mounts only the first section before anything scrolls into view', () => {
    const { rendered, view } = setup()

    expect([...new Set(rendered)]).toEqual([0])
    expect(view.container.querySelectorAll('[data-rendered]')).toHaveLength(1)
  })

  it('mounts a section when it intersects', () => {
    const { rendered, view } = setup()

    act(() => intersect(5))

    expect(rendered).toContain(5)
    expect(view.container.querySelector('[data-rendered="5"]')).not.toBeNull()
  })

  it('keeps the mounted window bounded while scrolling through everything', () => {
    const { view } = setup()

    for (let index = 0; index < 30; index += 1) {
      act(() => intersect(index))
    }

    // Default cap is 12 sections (the most recent), so the DOM cannot grow
    // with the document length.
    expect(view.container.querySelectorAll('[data-rendered]').length).toBeLessThanOrEqual(12)
    expect(view.container.querySelector('[data-rendered="29"]')).not.toBeNull()
    expect(view.container.querySelector('[data-rendered="0"]')).toBeNull()
  })
})
