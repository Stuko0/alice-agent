#!/usr/bin/env node
// Generates the large preview fixtures used by the manual WebKit matrix and
// the perf harness. They are intentionally NOT committed: a 2MB markdown file
// and a multi-megapixel PNG would bloat the repo, and they are deterministic
// to regenerate.
//
//   node scripts/gen-preview-fixtures.mjs
//
// Output: apps/desktop/preview-fixtures/large/

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'preview-fixtures', 'large')

mkdirSync(outDir, { recursive: true })

function write(name, content) {
  const path = join(outDir, name)
  writeFileSync(path, content)
  const size = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content)
  console.log(`wrote ${path} (${size} bytes)`)
}

// ── markdown ~2MB ─────────────────────────────────────────────────────────────
{
  const section = (index) => `## Section ${index}

Paragraph ${index} with **bold**, _italic_ and inline \`code ${index}\`.

\`\`\`ts
export function section${index}(input: string): string {
  return \`section ${index}: \${input}\`
}
\`\`\`

- item one
- item two
- item three

`
  let markdown = '# Large markdown fixture\n\n'

  for (let index = 0; markdown.length < 2 * 1024 * 1024; index += 1) {
    markdown += section(index)
  }

  write('md-large.md', markdown)
}

// ── python 30k lines ──────────────────────────────────────────────────────────
{
  const lines = ['# Large python fixture (plain-mode threshold: 20k lines)\n']

  for (let index = 0; index < 30_000; index += 1) {
    lines.push(`VALUE_${index} = ${index}  # generated line\n`)
  }

  write('py-large.py', lines.join(''))
}

// ── huge PNG (2600x2600, above the 2048 thumbnail threshold) ──────────────────
{
  const width = 2600
  const height = 2600
  const row = Buffer.alloc(1 + width * 3)

  // 8px colour blocks keep deflate fast while producing a realistic-sized file.
  const raw = Buffer.alloc((1 + width * 3) * height)

  for (let y = 0; y < height; y += 1) {
    const offset = y * (1 + width * 3)
    raw[offset] = 0 // filter: none
    const blockY = Math.floor(y / 8)

    for (let x = 0; x < width; x += 1) {
      const blockX = Math.floor(x / 8)
      const pixel = offset + 1 + x * 3
      raw[pixel] = (blockX * 7) & 0xff
      raw[pixel + 1] = (blockY * 11) & 0xff
      raw[pixel + 2] = (blockX + blockY) & 0xff
    }
  }

  write('img-huge.png', encodePng(raw, width, height))
  void row
}

// ── animated GIF (passthrough case) ───────────────────────────────────────────
{
  // Two 1x1 frames, 100ms delay, red then blue.
  const hex =
    '47494638396101000100800000000000ffffff21f9040100006400002c00000000010001000002024401003b' +
    '21f9040100006400002c00000000010001000002024c01003b'
  write('gif-anim.gif', Buffer.from(hex, 'hex'))
}

// ── huge text (truncation case) ───────────────────────────────────────────────
{
  const line = 'the quick brown fox jumps over the lazy dog — 0123456789\n'
  write('text-huge.log', line.repeat(Math.ceil((4 * 1024 * 1024) / line.length)))
}

function crc32(buffer) {
  let crc = 0xffffffff

  for (const byte of buffer) {
    crc ^= byte

    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }

  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)

  return Buffer.concat([length, typeAndData, crc])
}

function encodePng(rawRgb, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rawRgb, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
