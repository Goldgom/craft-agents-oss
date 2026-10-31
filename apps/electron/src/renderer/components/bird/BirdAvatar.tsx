import { useId } from 'react'
import birdIcon from '../../assets/branding/tokenbird.png'
import type { BirdCompanionState, BirdGesture } from '../../../shared/bird-companion'
import { getBirdPerformance, type BirdExpression } from './bird-performance'
import './bird-avatar.css'

// Isolate the face while keeping the top of the handheld panel stationary.
const HEAD = 'M0 0 H512 V200 H186 L172 181 H0 Z'
const WING = 'M350 273 L370 219 Q378 195 393 201 Q412 207 405 232 L432 207 Q449 195 458 212 Q466 226 451 245 Q477 226 484 247 Q492 265 467 280 Q490 276 485 296 Q482 320 425 331 Q370 340 352 306 Z'
const BEAK = 'M222 185 Q255 194 285 184 Q281 205 260 209 Q237 212 222 185 Z'

function Eyes({ expression }: { expression: BirdExpression }) {
  if (expression === 'happy') return <path d="M175 160 Q193 135 211 160 M296 160 Q314 135 332 160" fill="none" stroke="#171306" strokeWidth="9" strokeLinecap="round" />
  if (expression === 'sleepy') return <path d="M175 160 Q193 169 211 160 M296 160 Q314 169 332 160" fill="none" stroke="#171306" strokeWidth="7" strokeLinecap="round" />
  return <>
    <g className="bird-eyes" fill="#100e05">
      <ellipse cx="193" cy={expression === 'focused' ? 161 : 157} rx="19" ry={expression === 'focused' ? 14 : 23} />
      <ellipse cx="314" cy={expression === 'focused' ? 161 : 157} rx="19" ry={expression === 'focused' ? 14 : 23} />
      <g fill="#fffdf2"><circle cx="187" cy="151" r="4" /><circle cx="308" cy="151" r="4" /></g>
    </g>
    {expression === 'worried' && <path d="M173 128 L207 119 M298 119 L332 128" stroke="#6f4f10" strokeWidth="6" strokeLinecap="round" />}
    {expression === 'curious' && <path d="M296 122 Q314 113 332 122" fill="none" stroke="#6f4f10" strokeWidth="5" strokeLinecap="round" />}
  </>
}

export function BirdAvatar({ state, gesture = null, dragging = false, paused = false }: {
  state: Pick<BirdCompanionState, 'mood' | 'activity'>
  gesture?: BirdGesture | null
  dragging?: boolean
  paused?: boolean
}) {
  const id = useId().replaceAll(':', '')
  const { expression, motion, talking } = getBirdPerformance(state, gesture, dragging)
  return (
    <svg className={`bird-avatar bird-avatar--${state.mood} bird-motion--${motion} bird-expression--${expression} ${talking ? 'bird-avatar--talking' : ''}`}
      data-motion={motion} data-expression={expression} data-paused={paused} viewBox="0 42 512 416" aria-hidden="true">
      <defs>
        <mask id={`${id}-body`} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
          <rect width="512" height="512" fill="white" />
          <path d={HEAD} fill="black" /><path d={WING} fill="black" /><path d={BEAK} fill="black" />
        </mask>
        <mask id={`${id}-head`} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
          <path d={HEAD} fill="white" /><path d={BEAK} fill="black" />
        </mask>
        <clipPath id={`${id}-wing`}><path d={WING} /></clipPath>
        <clipPath id={`${id}-beak`}><path d={BEAK} /></clipPath>
        <radialGradient id={`${id}-face`} cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#fdd729" /><stop offset="1" stopColor="#fed82b" />
        </radialGradient>
      </defs>
      <g className="bird-rig">
        <image href={birdIcon} width="512" height="512" mask={`url(#${id}-body)`} />
        <g className="bird-head">
          <image href={birdIcon} width="512" height="512" mask={`url(#${id}-head)`} />
          {expression !== 'neutral' && <>
            <g fill={`url(#${id}-face)`}>
              <ellipse cx="193" cy="151" rx="32" ry="38" /><ellipse cx="314" cy="151" rx="32" ry="38" />
            </g>
            <Eyes expression={expression} />
          </>}
          <g className="bird-blink">
            <g fill={`url(#${id}-face)`}><ellipse cx="193" cy="157" rx="28" ry="30" /><ellipse cx="314" cy="157" rx="28" ry="30" /></g>
            <path d="M175 160 Q192 174 208 160 M298 160 Q315 174 331 160" fill="none" stroke="#201807" strokeWidth="5" strokeLinecap="round" />
          </g>
          {expression === 'happy' && <g fill="#ef8a42" opacity=".6"><ellipse cx="151" cy="181" rx="15" ry="8" /><ellipse cx="356" cy="181" rx="15" ry="8" /></g>}
          <path d={BEAK} fill="#c97000" />
          <g className="bird-beak"><image href={birdIcon} width="512" height="512" clipPath={`url(#${id}-beak)`} /></g>
        </g>
        <g className="bird-wing"><image href={birdIcon} width="512" height="512" clipPath={`url(#${id}-wing)`} /></g>
      </g>
      {expression === 'happy' && <g className="bird-sparkles" fill="#ffd43b">
        <path d="m80 104 4 11 11 4-11 4-4 11-4-11-11-4 11-4z" />
        <path d="m419 119 5 14 14 5-14 5-5 14-5-14-14-5 14-5z" />
      </g>}
      {expression === 'worried' && <path className="bird-tear" d="M361 141 Q349 158 361 161 Q373 158 361 141" fill="#71bdec" />}
      {motion === 'think' && <g className="bird-thought" fill="#dcb52f"><circle cx="419" cy="112" r="5" /><circle cx="433" cy="90" r="8" /><circle cx="450" cy="67" r="11" /></g>}
    </svg>
  )
}
