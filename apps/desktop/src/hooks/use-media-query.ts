import { useEffect, useState } from 'react'

export { matchesQuery } from '@/lib/media-query'

import { matchesQuery as matchesNow } from '@/lib/media-query'

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchesNow(query))

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return
    }

    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)

    setMatches(mql.matches)
    mql.addEventListener('change', onChange)

    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}
