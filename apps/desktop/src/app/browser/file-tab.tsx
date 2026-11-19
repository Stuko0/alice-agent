import { Suspense, useMemo } from 'react'

import { LocalFilePreview } from '@/app/chat/right-rail/preview-file'
import { localPreviewTarget } from '@/lib/local-preview'

/**
 * File tab body.
 *
 * Fase 3 absorbed the preview rail, so a `file` tab renders the SAME rich
 * previewer the rail used: markdown, syntax highlighting, diffs, images,
 * editing. The browser owns navigation, the previewer owns the file.
 */
export function FileTabView({ dataUrl, label, path }: { dataUrl?: string; label?: string; path: string }) {
  const target = useMemo(() => {
    const resolved = localPreviewTarget(path)

    if (!resolved) {
      return null
    }

    return {
      ...resolved,
      ...(dataUrl ? { dataUrl } : {}),
      ...(label ? { label } : {})
    }
  }, [dataUrl, label, path])

  if (!target) {
    return <p className="p-4 text-[0.75rem] text-(--ui-red)">Could not open {path}</p>
  }

  // The previewer pulls heavy chunks (highlighting/markdown) on first paint; a
  // boundary keeps a suspended child from turning into a sync-update error.
  return (
    <Suspense fallback={<p className="p-4 text-[0.75rem] text-(--ui-text-tertiary)">Loading preview…</p>}>
      <LocalFilePreview reloadKey={0} target={target} />
    </Suspense>
  )
}
