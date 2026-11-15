import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 18, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** Peryda's mark for Pery: the asterism ⁂ (never a sparkle). */
export function AsterismIcon({ size = 16, ...rest }: IconProps) {
  const star = (cx: number, cy: number, r: number) =>
    [0, 60, 120].map((deg) => {
      const a = (deg * Math.PI) / 180
      return <line key={deg} x1={cx - r * Math.sin(a)} y1={cy - r * Math.cos(a)} x2={cx + r * Math.sin(a)} y2={cy + r * Math.cos(a)} />
    })
  return (
    <Svg size={size} strokeWidth={1.6} {...rest}>
      {star(12, 7, 3.4)}
      {star(6.5, 16.5, 3.4)}
      {star(17.5, 16.5, 3.4)}
    </Svg>
  )
}

export const PlusIcon = (p: IconProps) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
export const CloseIcon = (p: IconProps) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>
export const BackIcon = (p: IconProps) => <Svg {...p}><path d="M15 18l-6-6 6-6" /></Svg>
export const SendIcon = (p: IconProps) => <Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>
export const StopIcon = (p: IconProps) => <Svg {...p}><rect x="7" y="7" width="10" height="10" rx="1.5" /></Svg>
export const RetryIcon = (p: IconProps) => <Svg {...p}><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4v4h4" /></Svg>
export const TrashIcon = (p: IconProps) => <Svg {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></Svg>
export const GearIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </Svg>
)
export const LinkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8" />
  </Svg>
)
export const ClipIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    <path d="M12 7v6M9 10h6" />
  </Svg>
)
/** The same bookmark, filled: the card is in the journal. */
export const ClipSavedIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" fill="currentColor" />
  </Svg>
)
/** Smaller and larger card text: an A with a minus or a plus. */
/** A highlighter pen ("Vurgula"). */
export const HighlighterIcon = (p: IconProps) => <Svg {...p}><path d="M14.5 4.5l5 5L11 18l-5 .5.5-5z" /><path d="M4 21h7" /><path d="M12.5 6.5l5 5" /></Svg>
export const TextSmallerIcon = (p: IconProps) => <Svg {...p}><path d="M3.5 18l4.5-10 4.5 10M5.1 14.5h5.8M15 12h6" /></Svg>
export const TextLargerIcon = (p: IconProps) => <Svg {...p}><path d="M2.5 19l5.5-13 5.5 13M4.5 14.8h7M15 11h6M18 8v6" /></Svg>
export const NoteIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5z" />
    <path d="M15 3v6h6" />
  </Svg>
)
export const MinimizeIcon = (p: IconProps) => <Svg {...p}><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></Svg>
export const MagnetIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 15l-4-4 6.8-6.8a5.6 5.6 0 0 1 8 8L10 19l-4-4 6.8-6.8a.4.4 0 0 0-.6-.6z" />
    <path d="M5 8l4 4M12 15l4 4" />
  </Svg>
)
export const EyeOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.7 5.1A10 10 0 0 1 12 5c7 0 10 7 10 7a13 13 0 0 1-1.7 2.7M6.6 6.6A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20" />
  </Svg>
)
export const EyeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
)
export const ZoomInIcon = (p: IconProps) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M11 8v6M8 11h6" /></Svg>
export const ZoomOutIcon = (p: IconProps) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M8 11h6" /></Svg>
export const CursorIcon = (p: IconProps) => <Svg {...p}><path d="M4 4l7 17 2.5-7.5L21 11z" /></Svg>
export const AreaIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
  </Svg>
)
export const KeyIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="M10.7 12.3L20 3M17 6l3 3M14 9l2 2" />
  </Svg>
)
export const BookIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 19.5V5a2 2 0 0 1 2-2h13v15H6.5A2.5 2.5 0 0 0 4 20.5 2.5 2.5 0 0 0 6.5 23H19v-5" />
    <path d="M9 7h6" />
  </Svg>
)
/** Two speech bubbles, one with a Latin letter and one with a 文: a translation, not just a letter. */
export const TranslateIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 3h8A1.5 1.5 0 0 1 14 4.5V10a1.5 1.5 0 0 1-1.5 1.5H8L5 14v-2.5h-.5A1.5 1.5 0 0 1 3 10V4.5A1.5 1.5 0 0 1 4.5 3z" />
    <path d="M6.2 9.6L8.5 4.9l2.3 4.7M7 8.1h3" strokeWidth={1.4} />
    <path d="M11.5 10.5h8A1.5 1.5 0 0 1 21 12v5.5a1.5 1.5 0 0 1-1.5 1.5H19V21l-3-2h-4.5a1.5 1.5 0 0 1-1.5-1.5V12a1.5 1.5 0 0 1 1.5-1.5z" fill="currentColor" />
    <path d="M13 13.1h5M15.5 12v1.1M14 14.4c.6 1.6 1.8 2.7 3.6 3.2M17 14.4c-.6 1.6-1.8 2.7-3.6 3.2" stroke="var(--icon-knockout, var(--paper-raised))" strokeWidth={1.3} />
  </Svg>
)
export const ChevronLeftIcon = (p: IconProps) => <Svg {...p}><path d="M15 18l-6-6 6-6" /></Svg>
export const ChevronRightIcon = (p: IconProps) => <Svg {...p}><path d="M9 18l6-6-6-6" /></Svg>
export const ChevronDownIcon = (p: IconProps) => <Svg {...p}><path d="M6 9l6 6 6-6" /></Svg>
export const ChevronUpIcon = (p: IconProps) => <Svg {...p}><path d="M6 15l6-6 6 6" /></Svg>
/** One long scroll of pages. */
export const ScrollIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="2.5" width="12" height="8" rx="1.2" />
    <rect x="6" y="13.5" width="12" height="8" rx="1.2" />
  </Svg>
)
/** A single page at a time. */
export const PageIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14 3v4h4" />
  </Svg>
)
/** A page's text drawn out of it. */
export const TextIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M9 11h6M9 14.5h6M9 18h4" />
  </Svg>
)
export const CheckIcon = (p: IconProps) => <Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>
