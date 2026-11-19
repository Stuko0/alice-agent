/**
 * Pure directive formatting shared by the assistant-ui renderer (React) and
 * `lib/chat-runtime.ts` (data/runtime helpers). Extracted from
 * `components/assistant-ui/directive-text.tsx` for D2: `lib/` must not import a
 * component module for a string helper.
 */

function needsQuoting(value: string): boolean {
  return /[\s()[\]{}<>"'`]/.test(value)
}

/** Quote a ref/id only when it needs it (spaces, brackets, quotes, backticks). */
export function formatRefValue(value: string): string {
  if (!needsQuoting(value)) {
    return value
  }

  if (!value.includes('`')) {
    return `\`${value}\``
  }

  if (!value.includes('"')) {
    return `"${value}"`
  }

  if (!value.includes("'")) {
    return `'${value}'`
  }

  return value
}
