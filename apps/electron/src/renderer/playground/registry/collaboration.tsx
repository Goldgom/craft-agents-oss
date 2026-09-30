import type { ComponentEntry } from './types'
import { CollaborationDialogPreview } from '../demos/collaboration/CollaborationDialogPreview'

export const collaborationComponents: ComponentEntry[] = [{
  id: 'collaboration-dialog',
  name: 'Collaboration setup',
  category: 'Session List',
  description: 'Synthetic current/saved-server selection, existing/new sessions, empty workspace, slow responses, cancellation and offline recovery.',
  component: CollaborationDialogPreview,
  layout: 'full',
  props: [{ name: 'scenario', control: { type: 'select', options: [
    { label: 'Normal', value: 'normal' }, { label: 'Slow requests', value: 'slow' }, { label: 'Remote offline', value: 'offline' },
  ] }, defaultValue: 'normal' }],
  variants: [
    { name: 'Normal', props: { scenario: 'normal' } },
    { name: 'Slow requests', props: { scenario: 'slow' } },
    { name: 'Remote offline', props: { scenario: 'offline' } },
  ],
}]
