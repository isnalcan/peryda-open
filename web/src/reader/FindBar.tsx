import { forwardRef, type KeyboardEvent } from 'react'
import { useI18n } from '../i18n/I18n'
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, SearchIcon } from '../ui/icons'

interface Props {
  query: string
  onQuery: (query: string) => void
  /** Matches found so far, and the current one (−1 before one is chosen). */
  count: number
  index: number
  searching: boolean
  /** The search stopped at its limit: the count reads "5000+". */
  capped?: boolean
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
}

/**
 * Find in the document, at the top of the reader (Ctrl/Cmd+F, owner 16 Nov): Enter for the next match,
 * Shift+Enter for the previous one, Escape closes. The counter reads "3 / 17".
 */
export const FindBar = forwardRef<HTMLInputElement, Props>(function FindBar(props, ref) {
  const { t } = useI18n()
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (e.shiftKey) props.onPrevious()
      else props.onNext()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      props.onClose()
    }
  }
  const blank = !props.query.trim()
  const counter = blank ? '' : props.count > 0 ? `${Math.max(props.index, 0) + 1} / ${props.count}${props.capped ? '+' : ''}` : props.searching ? '…' : t.findNone
  return (
    <div className="find-bar" role="search" onPointerDown={(e) => e.stopPropagation()}>
      <SearchIcon size={15} className="find-icon" />
      <input
        ref={ref}
        type="text"
        value={props.query}
        placeholder={t.findPlaceholder}
        aria-label={t.findPlaceholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => props.onQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className={`find-count${!blank && props.count === 0 && !props.searching ? ' is-none' : ''}`} aria-live="polite">
        {counter}
      </span>
      <button type="button" className="icon-button" title={t.findPrevious} aria-label={t.findPrevious} disabled={props.count === 0} onClick={props.onPrevious}>
        <ChevronUpIcon size={16} />
      </button>
      <button type="button" className="icon-button" title={t.findNext} aria-label={t.findNext} disabled={props.count === 0} onClick={props.onNext}>
        <ChevronDownIcon size={16} />
      </button>
      <button type="button" className="icon-button" title={t.close} aria-label={t.close} onClick={props.onClose}>
        <CloseIcon size={16} />
      </button>
    </div>
  )
})
