import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { getHelpTask, listHelpTopics, type HelpTaskContent, type HelpTopic } from '@/alice'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Loader2 } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * Task-scoped help overlay: "How do I add a provider / back up / connect
 * Telegram?" → the exact doc page, rendered in-app. Mirrors the same index
 * the CLI exposes via `alice help <topic>`.
 */
export function HelpOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const copy = t.settings.providers

  const [topics, setTopics] = useState<HelpTopic[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<HelpTaskContent | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }
    setSelected(null)
    setContent(null)
    void listHelpTopics()
      .then(setTopics)
      .catch(() => setTopics([]))
  }, [open])

  useEffect(() => {
    if (!selected) {
      return
    }
    setLoading(true)
    void getHelpTask(selected)
      .then(c => {
        setContent(c)
        setLoading(false)
      })
      .catch(() => {
        setContent(null)
        setLoading(false)
      })
  }, [selected])

  return (
    <Dialog onOpenChange={onClose} open={open}>
      <DialogContent className="max-h-[85vh] max-w-3xl gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">{copy.helpTitle}</DialogTitle>
        <div className="flex h-[70vh] flex-col">
          <div className="flex items-center justify-between border-b border-(--ui-border) px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">{copy.helpTitle}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{copy.helpIntro}</p>
            </div>
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
            <nav className="min-h-0 overflow-y-auto border-r border-(--ui-border) p-2">
              {topics.map(topic => (
                <button
                  className={cn(
                    'block w-full rounded-[6px] px-2.5 py-2 text-left text-xs transition-colors hover:bg-(--ui-control-hover-background)',
                    selected === topic.id && 'bg-primary/10 text-primary'
                  )}
                  key={topic.id}
                  onClick={() => setSelected(topic.id)}
                  type="button"
                >
                  <span className="block font-semibold">{topic.title}</span>
                  <span className="mt-0.5 block leading-4 text-muted-foreground">{topic.description}</span>
                </button>
              ))}
            </nav>
            <div className="min-h-0 overflow-y-auto p-4">
              {loading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading…
                </div>
              )}
              {!loading && !selected && (
                <p className="text-xs text-muted-foreground">{copy.helpIntro}</p>
              )}
              {!loading && selected && content?.doc_available && (
                <MarkdownDoc markdown={content.markdown} />
              )}
              {!loading && selected && (!content || !content.doc_available) && (
                <p className="text-xs text-muted-foreground">Doc not bundled with this build.</p>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Minimal markdown renderer — good enough for the doc pages. */
function MarkdownDoc({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => splitBlocks(markdown), [markdown])

  return (
    <div className="prose-sm space-y-3 text-[0.8125rem] leading-relaxed">
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  )
}

type Block =
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'empty' }

function splitBlocks(md: string): Block[] {
  const lines = md.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      i += 1
      continue
    }
    if (line.startsWith('```')) {
      const buf: string[] = []
      i += 1
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i])
        i += 1
      }
      i += 1
      blocks.push({ kind: 'code', text: buf.join('\n') })
      continue
    }
    const h2 = /^##\s+(.*)$/.exec(line)
    if (h2) {
      blocks.push({ kind: 'h2', text: h2[1] })
      i += 1
      continue
    }
    const h3 = /^###\s+(.*)$/.exec(line)
    if (h3) {
      blocks.push({ kind: 'h3', text: h3[1] })
      i += 1
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''))
        i += 1
      }
      blocks.push({ kind: 'ul', items })
      continue
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''))
        i += 1
      }
      blocks.push({ kind: 'ol', items })
      continue
    }
    // Paragraph: consume until a blank line or a new block marker.
    const buf: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('```') &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i])
    ) {
      buf.push(lines[i])
      i += 1
    }
    blocks.push({ kind: 'p', text: buf.join(' ') })
  }

  return blocks
}

function Inline({ text }: { text: string }) {
  // Backtick code spans + [link](url) — everything else passes through.
  const parts = text.split(/(`[^`]+`|\[[^\]]+\]\([^)]+\))/g).filter(Boolean)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code className="rounded bg-(--ui-control-hover-background) px-1 py-0.5 font-mono text-[0.75rem]" key={i}>
              {part.slice(1, -1)}
            </code>
          )
        }
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
        if (link) {
          return (
            <a className="text-primary underline" href={link[2]} key={i} rel="noreferrer" target="_blank">
              {link[1]}
            </a>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}

function Block({ block }: { block: Block }) {
  switch (block.kind) {
    case 'h2':
      return <h3 className="text-sm font-semibold">{block.text}</h3>
    case 'h3':
      return <h4 className="text-[0.8125rem] font-semibold">{block.text}</h4>
    case 'p':
      return (
        <p>
          <Inline text={block.text} />
        </p>
      )
    case 'ul':
      return (
        <ul className="list-disc space-y-1 pl-5">
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </ul>
      )
    case 'ol':
      return (
        <ol className="list-decimal space-y-1 pl-5">
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </ol>
      )
    case 'code':
      return (
        <pre className="overflow-x-auto rounded-[6px] bg-(--ui-control-hover-background) p-3 font-mono text-[0.75rem] leading-relaxed">
          {block.text}
        </pre>
      )
    default:
      return null
  }
}

export function HelpFab({ onClick }: { onClick: () => void }): ReactNode {
  const { t } = useI18n()
  return (
    <button
      aria-label={t.settings.providers.helpOpen}
      className="fixed bottom-5 right-5 z-50 flex size-10 items-center justify-center rounded-full border border-(--stroke-nous) bg-(--ui-chat-bubble-background) text-base font-semibold text-(--theme-primary) shadow-nous transition-transform hover:scale-105"
      onClick={onClick}
      title={t.settings.providers.helpOpen}
      type="button"
    >
      ?
    </button>
  )
}
