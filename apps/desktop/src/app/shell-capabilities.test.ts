import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// D5 invariant: UI code must ask "does this shell support X?" (a capability)
// instead of "is this Wails?" (an identity check). Shell identity in a component
// hardcodes today's two shells into feature logic and silently skips the
// capability table when a third shell appears.
//
// `lib/desktop-capabilities.ts` itself may call `isWailsShell()`; nothing under
// `app/` or `components/` may.

const ROOT = join(import.meta.dirname, '..')

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)

    if (stat.isDirectory()) {
      walk(full, files)
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      files.push(full)
    }
  }

  return files
}

describe('shell capability discipline', () => {
  it('no component or page calls isWailsShell() directly', () => {
    const offenders: string[] = []

    for (const file of [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components'))]) {
      const source = readFileSync(file, 'utf8')

      if (source.includes('isWailsShell(') || /import\s*\{[^}]*isWailsShell/.test(source)) {
        offenders.push(file.replace(`${ROOT}/`, ''))
      }
    }

    expect(offenders).toEqual([])
  })

  it('every announced capability is reported by the Wails table', async () => {
    const { wailsCapabilities } = await import('@/lib/wails-bridge')
    const { desktopSupports } = await import('@/lib/desktop-capabilities')

    // In Electron every capability is true; in Wails the table decides. This
    // asserts the table is kept in sync with the union (a missing key would
    // read as `undefined`, i.e. "unsupported", for an Electron-only feature).
    for (const capability of Object.keys(wailsCapabilities)) {
      expect(typeof (wailsCapabilities as Record<string, boolean>)[capability]).toBe('boolean')
      expect(typeof desktopSupports(capability as never)).toBe('boolean')
    }
  })
})
