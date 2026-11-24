/**
 * Fired (window CustomEvent<{ id }>) to toggle a force-collapsed pane's reveal
 * from the keyboard or a statusbar button, since its store-open toggle is a
 * no-op while collapsed.
 *
 * Lives in `lib/` (not in the component module) so stores can dispatch it
 * without importing React: `store/review.ts` used to import it from
 * `@/components/pane-shell`, which dragged the whole component tree (and React)
 * into the data layer.
 */
export const PANE_TOGGLE_REVEAL_EVENT = 'alice:pane-toggle-reveal'
