import { atomWithStorage } from 'jotai/utils'

export type ModelGroupExpansion = 'current' | 'all-expanded' | 'all-collapsed'

export const modelGroupExpansionAtom = atomWithStorage<ModelGroupExpansion>(
  'tokenbird-model-group-expansion:v1',
  'current',
  undefined,
  { getOnInit: true },
)
