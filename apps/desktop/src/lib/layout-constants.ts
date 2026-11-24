/**
 * Layout breakpoints shared by the shell (React) and by stores.
 *
 * `SIDEBAR_COLLAPSE_MEDIA_QUERY` moved here from `app/layout-constants.ts` so
 * `store/review.ts` can decide "narrow window" without importing page code (D2).
 */
export const SIDEBAR_COLLAPSE_BREAKPOINT_PX = 768
export const SIDEBAR_COLLAPSE_MEDIA_QUERY = `(max-width: ${SIDEBAR_COLLAPSE_BREAKPOINT_PX}px)`
