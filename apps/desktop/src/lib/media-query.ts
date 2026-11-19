/**
 * Pure `matchMedia` probe. Lives in `lib/` so stores can read a media query
 * without importing a React hook module (D2: `store/` must not import from
 * `hooks/`, `app/` or `components/`).
 */
export const matchesQuery = (query: string): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches
