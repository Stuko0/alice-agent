import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// D2 contract: the data layer (`store/`, `lib/`) must not import runtime values
// from the UI layer (`app/`, `components/`, `hooks/`). Type-only imports are
// allowed (erased at build time, no runtime cycle); value imports are not.
//
// This is what kept `store/review.ts` pulling the whole pane component tree just
// for an event-name constant, and `store/session.ts` importing a page helper.

const ROOT = import.meta.dirname
const UI_PREFIXES = ['@/app/', '@/components/', '@/hooks/', '../app/', '../../app/', '../components/', '../../components/', '../hooks/']

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)

    if (statSync(full).isDirectory()) {
      walk(full, files)
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      files.push(full)
    }
  }

  return files
}

interface ImportStatement {
  clause: string
  source: string
}

function importsOf(source: string): ImportStatement[] {
  const found: ImportStatement[] = []
  const re = /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null

  while ((match = re.exec(source)) !== null) {
    found.push({ clause: match[1].trim(), source: match[2] })
  }

  return found
}

function isTypeOnly(clause: string): boolean {
  if (clause.startsWith('type ')) {
    return true
  }

  // `import { type A, type B } from` — every named specifier is a type.
  const named = clause.match(/^\{([\s\S]*)\}$/)

  if (!named) {
    return false
  }

  const specifiers = named[1]
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)

  return specifiers.length > 0 && specifiers.every(part => part.startsWith('type '))
}

describe('layer contract (D2)', () => {
  it('store/ and lib/ import no runtime values from app/, components/ or hooks/', () => {
    const violations: string[] = []

    for (const file of [...walk(join(ROOT, 'store')), ...walk(join(ROOT, 'lib'))]) {
      for (const statement of importsOf(readFileSync(file, 'utf8'))) {
        const crossesLayer = UI_PREFIXES.some(prefix => statement.source.startsWith(prefix))

        if (!crossesLayer || isTypeOnly(statement.clause)) {
          continue
        }

        violations.push(`${file.replace(`${ROOT}/`, '')} → ${statement.source}`)
      }
    }

    expect(violations).toEqual([])
  })
})
