import { NativeCredentialManager } from '@/components/settings/NativeCredentialManager'
import { useAppShellContext } from '@/context/AppShellContext'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

export const meta: DetailsPageMeta = { navigator: 'settings', slug: 'credentials' }

export default function CredentialsSettingsPage() {
  const { activeWorkspaceId } = useAppShellContext()
  return <NativeCredentialManager workspaceId={activeWorkspaceId} />
}
