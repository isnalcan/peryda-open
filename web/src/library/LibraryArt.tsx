/**
 * A quiet drawing in the library's bottom-right corner: a thread comes in from the edge, ties one
 * loop (an İlmek) with a knot, and trails off with a loose end. It draws itself once when the
 * library opens. Decoration only: hidden from assistive technology, never catches the pointer.
 * The Mac app draws the same shape (mac/PerydaMac/Library/LibraryArt.swift).
 */
export function LibraryArt() {
  return (
    <svg className="library-art" viewBox="0 0 520 420" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path
        className="library-art-thread"
        pathLength={1}
        strokeWidth={2.8}
        d="M 560 392 C 470 392, 412 362, 372 324 C 330 284, 304 236, 338 206 C 372 176, 424 206, 398 246 C 372 286, 304 286, 268 250 C 240 222, 226 190, 220 164"
      />
      <g className="library-art-knot">
        <circle cx="331" cy="271" r="4.6" fill="currentColor" stroke="none" />
        <circle cx="335.5" cy="275" r="3.9" fill="currentColor" stroke="none" />
        <path strokeWidth={2} d="M 336 278 C 344 290, 343 300, 335 309" />
        <path strokeWidth={2} d="M 331 279 C 328 291, 321 297, 313 300" />
      </g>
    </svg>
  )
}
