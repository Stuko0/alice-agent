/**
 * Chat backdrop.
 *
 * The desktop used to paint a licensed illustration here (and a Leva panel to
 * tune it). The Alice identity is flat on purpose: a faint ink hatch under the
 * thread keeps the surface alive without competing with text, images or code.
 * Pure CSS — no asset, no layout, no animation, nothing to tune at runtime.
 */
export function Backdrop() {
  return (
    <div
      aria-hidden
      className="texture-veil pointer-events-none absolute inset-0 z-0 opacity-100"
      data-slot="chat-backdrop"
    />
  )
}
