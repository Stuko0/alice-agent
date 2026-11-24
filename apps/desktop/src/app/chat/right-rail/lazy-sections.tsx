import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

// Sectioned, bounded rendering for long documents.
//
// A multi-megabyte markdown file rendered in one pass builds the entire AST and
// DOM at once: seconds of blocking work and a heap that never shrinks. This
// splits the text into stable sections and mounts only the ones near the
// viewport, keeping a bounded LRU of mounted sections so scrolling through a
// huge document does not grow memory without limit. Unmounted sections keep a
// measured placeholder height so the scrollbar does not jump.

const DEFAULT_MAX_MOUNTED = 12
const SECTION_CHAR_LIMIT = 6000
const PLACEHOLDER_MIN_HEIGHT = 160
const OBSERVER_MARGIN = '600px 0px'

// Split on top-level headings first (the usual markdown structure), then
// hard-split any oversized part so one giant section cannot defeat the window.
export function splitMarkdownSections(text: string): string[] {
  if (!text) {
    return []
  }

  const lines = text.split('\n')
  const parts: string[] = []
  let current: string[] = []
  let inFence = false

  const flush = () => {
    if (current.length) {
      parts.push(current.join('\n'))
      current = []
    }
  }

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
    }

    const isHeading = !inFence && /^##\s/.test(line)

    if (isHeading && current.length) {
      flush()
    }

    current.push(line)
  }

  flush()

  const sections: string[] = []

  for (const part of parts) {
    if (part.length <= SECTION_CHAR_LIMIT) {
      sections.push(part)

      continue
    }

    for (let start = 0; start < part.length; start += SECTION_CHAR_LIMIT) {
      sections.push(part.slice(start, start + SECTION_CHAR_LIMIT))
    }
  }

  return sections
}

interface SectionProps {
  children: ReactNode
  index: number
  onHeight: (index: number, height: number) => void
}

function MeasuredSection({ children, index, onHeight }: SectionProps) {
  const ref = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0

    if (height > 0) {
      onHeight(index, height)
    }
  })

  return <div ref={ref}>{children}</div>
}

export interface LazySectionsProps {
  maxMounted?: number
  renderSection: (text: string, index: number) => ReactNode
  text: string
}

export function LazySections({ maxMounted = DEFAULT_MAX_MOUNTED, renderSection, text }: LazySectionsProps) {
  const sections = useMemo(() => splitMarkdownSections(text), [text])
  const rootRef = useRef<HTMLDivElement | null>(null)
  const heights = useRef<Map<number, number>>(new Map())
  const [mounted, setMounted] = useState<number[]>(() => (sections.length > 0 ? [0] : []))

  // New document → forget the previous window/heights.
  useEffect(() => {
    heights.current = new Map()
    setMounted(sections.length > 0 ? [0] : [])
  }, [sections])

  useEffect(() => {
    const root = rootRef.current

    if (!root) {
      return
    }

    if (sections.length === 0) {
      return
    }

    // No IntersectionObserver (older WebKit, jsdom): mount a bounded tail
    // instead of hiding the document. Content stays readable; the bound still
    // prevents an unbounded DOM.
    if (typeof IntersectionObserver === 'undefined') {
      setMounted(sections.map((_, index) => index).slice(-maxMounted))

      return
    }

    const observer = new IntersectionObserver(
      entries => {
        const seen: number[] = []

        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue
          }

          const index = Number((entry.target as HTMLElement).dataset.section)

          if (!Number.isNaN(index)) {
            seen.push(index)
          }
        }

        if (seen.length === 0) {
          return
        }

        setMounted(previous => {
          const next = previous.filter(index => !seen.includes(index))
          next.push(...seen)

          return next.slice(-maxMounted)
        })
      },
      { root, rootMargin: OBSERVER_MARGIN }
    )

    root.querySelectorAll('[data-section]').forEach(element => observer.observe(element))

    return () => observer.disconnect()
  }, [maxMounted, sections])

  return (
    <div ref={rootRef}>
      {sections.map((section, index) => {
        const isMounted = mounted.includes(index)
        const measured = heights.current.get(index)

        return (
          <div
            data-section={index}
            key={index}
            style={isMounted ? undefined : { minHeight: measured ?? PLACEHOLDER_MIN_HEIGHT }}
          >
            {isMounted ? (
              <MeasuredSection
                index={index}
                onHeight={(sectionIndex, height) => {
                  heights.current.set(sectionIndex, height)
                }}
              >
                {renderSection(section, index)}
              </MeasuredSection>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
