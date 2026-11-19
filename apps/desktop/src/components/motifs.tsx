import { cn } from '@/lib/utils'

/**
 * Decorative motifs for the Alice identity.
 *
 * The "Madness" look uses a restrained Victorian card-suit language: one suit
 * per sidebar section and a keyhole for empty states. Everything here is
 * strictly decorative — `aria-hidden`, not focusable, no animation, and no
 * pointer events — so it can never interfere with reading or keyboard order.
 */

export type Suit = 'club' | 'diamond' | 'heart' | 'spade'

const SUIT_GLYPH: Record<Suit, string> = {
  club: '♣',
  diamond: '♦',
  heart: '♥',
  spade: '♠'
}

/** One suit glyph. Sized in `em` so it follows the surrounding type scale. */
export function SuitMark({
  suit,
  className,
  size = '0.72em'
}: {
  suit: Suit
  className?: string
  size?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn('pointer-events-none inline-block shrink-0 select-none font-serif leading-none', className)}
      data-motif={suit}
      style={{ fontSize: size }}
    >
      {SUIT_GLYPH[suit]}
    </span>
  )
}

/** A small centered suit row used as a section/footer divider. */
export function SuitDivider({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none flex select-none items-center justify-center gap-1.5 text-(--ui-text-quaternary) opacity-45',
        className
      )}
      data-slot="suit-divider"
    >
      {(['spade', 'heart', 'diamond', 'club'] as const).map(suit => (
        <SuitMark key={suit} size="0.5rem" suit={suit} />
      ))}
    </span>
  )
}

/** Keyhole mark for empty states. Stroke-based so it inherits text color. */
export function KeyholeMark({ className, size = '1.1rem' }: { className?: string; size?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn('pointer-events-none shrink-0 select-none', className)}
      data-slot="keyhole"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.4"
      viewBox="0 0 24 24"
      width={size}
    >
      <circle cx="12" cy="9" r="4.1" />
      <path d="M9.9 12.4 8 20h8l-1.9-7.6" />
    </svg>
  )
}
