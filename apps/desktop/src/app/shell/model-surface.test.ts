import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// The model was painted three times: the composer pill (the only interactive
// one), the running-head chip (display only) and the ribbon segment (display
// only). Three copies of the same fact is noise, and only one of them can
// change the model. This pins the contract: the composer owns it.

const ROOT = import.meta.dirname
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

describe('model surface', () => {
  it('is rendered only by the composer pill', () => {
    expect(read('../chat/composer/controls.tsx')).toContain('<ModelPill')

    // The two read-only duplicates are gone for good.
    expect(read('./running-head.tsx')).not.toContain('$currentModel')
    expect(read('./ribbon.tsx')).not.toContain('$currentModel')
  })

  it('keeps the picker menu with edit and refresh in the pill', () => {
    const pill = read('../chat/composer/model-pill.tsx')

    expect(pill).toContain('ModelMenu')
    // The menu content is injected by the shell (model list + actions).
    expect(read('./model-menu-panel.tsx')).toContain('editModels')
    expect(read('./model-menu-panel.tsx')).toContain('refreshModels')
  })
})
