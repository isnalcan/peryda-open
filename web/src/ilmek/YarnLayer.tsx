import { memo } from 'react'
import { YARN_STROKE } from '../styles/tokens'
import { bentPath } from './rope'
import type { Point, YarnColor } from './types'

export interface YarnSegment {
  key: string
  color: YarnColor
  from: Point
  to: Point
  dashed?: boolean
  /** The card the yarn ends at and, for threads opened inside a card, the card it starts from. */
  cardId?: string
  sourceCardId?: string
}

/** Bezier threads between page anchors and cards, drawn in world space under the cards; `bends` adds the rope motion. */
function YarnLayerImpl({ segments, bends, x = 0, width, height }: { segments: readonly YarnSegment[]; bends?: ReadonlyMap<string, Point>; x?: number; width: number; height: number }) {
  // The world reaches left of the pages (threads can sit on either side), so the layer starts at x.
  return (
    <svg className="yarn-layer" width={width} height={height} viewBox={`${x} 0 ${width} ${height}`} style={{ left: x }} aria-hidden="true">
      {segments.map((s) => {
        const d = bentPath(s.from, s.to, bends?.get(s.key))
        const stroke = `var(--yarn-${s.color})`
        return (
          <g key={s.key} className={s.dashed ? 'yarn is-live' : 'yarn'}>
            <path d={d} stroke={stroke} strokeWidth={YARN_STROKE.haloWidth} strokeOpacity={YARN_STROKE.haloOpacity} fill="none" />
            <path
              d={d}
              stroke={stroke}
              strokeWidth={YARN_STROKE.mainWidth}
              strokeOpacity={YARN_STROKE.mainOpacity}
              strokeDasharray={s.dashed ? '5 5' : undefined}
              fill="none"
              strokeLinecap="round"
            />
            <circle cx={s.from[0]} cy={s.from[1]} r={YARN_STROKE.startKnotRadius} fill={stroke} />
            <circle cx={s.to[0]} cy={s.to[1]} r={YARN_STROKE.endKnotRadius} fill={stroke} />
          </g>
        )
      })}
    </svg>
  )
}

export const YarnLayer = memo(YarnLayerImpl)
