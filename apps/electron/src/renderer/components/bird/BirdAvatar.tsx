import { useId } from 'react'
import birdIcon from '../../assets/branding/tokenbird.png'
import type { BirdMood } from '../../../shared/bird-companion'

// The layers all use the actual application icon. Masks isolate the waving wing
// and lower beak; the jacket and blue panel retain the original artwork.
const WING = 'M350 273 L370 219 Q378 195 393 201 Q412 207 405 232 L432 207 Q449 195 458 212 Q466 226 451 245 Q477 226 484 247 Q492 265 467 280 Q490 276 485 296 Q482 320 425 331 Q370 340 352 306 Z'
const BEAK = 'M222 185 Q255 194 285 184 Q281 205 260 209 Q237 212 222 185 Z'

export function BirdAvatar({ mood }: { mood: BirdMood }) {
  const id = useId().replaceAll(':', '')
  const talking = mood !== 'idle'
  return (
    <svg className={`bird-avatar bird-avatar--${mood} ${talking ? 'bird-avatar--talking' : ''}`} viewBox="0 0 512 512" aria-hidden="true">
      <defs>
        <mask id={`${id}-body`} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
          <rect width="512" height="512" fill="white" />
          <path d={WING} fill="black" /><path d={BEAK} fill="black" />
        </mask>
        <clipPath id={`${id}-wing`}><path d={WING} /></clipPath>
        <clipPath id={`${id}-beak`}><path d={BEAK} /></clipPath>
        <linearGradient id={`${id}-lid`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe633" /><stop offset="1" stopColor="#ffda2e" />
        </linearGradient>
      </defs>
      <g className="bird-rig">
        <image href={birdIcon} width="512" height="512" mask={`url(#${id}-body)`} />
        <path d={BEAK} fill="#c97000" />
        <g className="bird-beak"><image href={birdIcon} width="512" height="512" clipPath={`url(#${id}-beak)`} /></g>
        <g className="bird-wing"><image href={birdIcon} width="512" height="512" clipPath={`url(#${id}-wing)`} /></g>
        <g className="bird-blink">
          <ellipse cx="193" cy="157" rx="27" ry="29" fill={`url(#${id}-lid)`} />
          <ellipse cx="314" cy="157" rx="27" ry="29" fill={`url(#${id}-lid)`} />
          <path d="M175 160 Q192 174 208 160 M298 160 Q315 174 331 160" fill="none" stroke="#201807" strokeWidth="5" strokeLinecap="round" />
        </g>
      </g>
      {mood === 'success' && <g className="bird-sparkles" fill="#ffd43b">
        <path d="m80 104 4 11 11 4-11 4-4 11-4-11-11-4 11-4z" />
        <path d="m419 119 5 14 14 5-14 5-5 14-5-14-14-5 14-5z" />
      </g>}
    </svg>
  )
}
