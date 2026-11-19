/**
 * Visibility rule for the native browser surface.
 *
 * The page is a GTK widget layered over the renderer's DOM, so it wins every
 * paint in its rect. That is only correct while the browser itself is the thing
 * on screen: the moment the app paints a dialog, menu, popover or palette over
 * that area, the native view has to disappear (and come back when the layer
 * closes).
 *
 * "A layer is up" is read from the DOM rather than counted in React state:
 * every Radix overlay marks its content with `data-slot` + `data-state`, and a
 * live query cannot leak a stale count when a node is replaced or unmounted
 * mid-animation.
 */

/** Content slots that paint a surface over the app. Tooltips are excluded. */
const OVERLAY_SLOTS = [
  'dialog-content',
  'dropdown-menu-content',
  'popover-content',
  'context-menu-content',
  'alert-dialog-content'
] as const

/** Marker for custom full-window overlays that don't use the primitives. */
const LAYER_ATTRIBUTE = 'data-surface-layer'

export const OVERLAY_SELECTOR = [
  ...OVERLAY_SLOTS.map(slot => `[data-slot="${slot}"][data-state="open"]`),
  `[${LAYER_ATTRIBUTE}]`,
  // Our dialog wrapper renders Content without a slot on the palette/keybind
  // panel, so they carry the attribute directly.
  `[${LAYER_ATTRIBUTE}="open"]`
].join(',')

/** Is any surface layer painted over the app right now? */
export function surfaceLayerPresent(root: ParentNode | null = typeof document === 'undefined' ? null : document) {
  if (!root) {
    return false
  }

  return root.querySelector(OVERLAY_SELECTOR) !== null
}

/**
 * Watch the document for layers appearing/disappearing. rAF-throttled: the chat
 * streams DOM updates constantly and a synchronous query per mutation batch
 * would be main-thread noise.
 */
export function watchSurfaceLayers(onChange: (present: boolean) => void): () => void {
  if (typeof document === 'undefined') {
    return () => {}
  }

  let pending = false
  let last = surfaceLayerPresent()

  const check = () => {
    const next = surfaceLayerPresent()

    if (next !== last) {
      last = next
      onChange(next)
    }
  }

  // `pending` is set before scheduling so a synchronous rAF stub (tests) can't
  // leave the watcher latched on a frame id that already fired.
  const schedule = () => {
    if (pending) {
      return
    }

    pending = true
    requestAnimationFrame(() => {
      pending = false
      check()
    })
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { attributeFilter: ['data-state'], attributes: true, childList: true, subtree: true })

  return () => observer.disconnect()
}

export interface BrowserSurfaceInput {
  /** Drawer open, chat route active, a web tab selected. */
  baseVisible: boolean
  /** A dialog/menu/popover/palette is painted over the app. */
  overlays: boolean
}

export function browserSurfaceVisible({ baseVisible, overlays }: BrowserSurfaceInput): boolean {
  if (!baseVisible) {
    return false
  }

  // A layer is up: the DOM must win until it closes.
  return !overlays
}
