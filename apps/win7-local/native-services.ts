// Reuse the original desktop services; build-time patches handle old Electron.
export { exportChatTranscript } from '../electron/src/main/chat-export'
export { openTokenNestRechargeWindow } from '../electron/src/main/tokennest-recharge'
export { readMindMapSession, writeMindMapSession, deleteMindMapSession, mindMapWorkspaceContext } from '../electron/src/main/studio-mindmap-files'
export { getRuntimeToolStatuses, updateRuntimeToolPath, applyRuntimeToolEnvironment } from '../electron/src/main/runtime-toolchains'
export { applyConfiguredProxySettings, updateConfiguredProxySettings } from '../electron/src/main/network-proxy'
import { getRuntimeToolPaths, setRuntimeToolPath, getGitBashPath, setGitBashPath } from '../../packages/shared/src/config/storage'

export function importInstalledToolPaths(tools: Record<string, { executable: string }>) {
  const configured = getRuntimeToolPaths()
  for (const id of ['java', 'python', 'node'] as const) {
    // Preserve paths explicitly chosen in the original settings UI.
    if (!configured[id] && tools[id]) setRuntimeToolPath(id, tools[id].executable)
  }
  if (!getGitBashPath() && tools.git) setGitBashPath(tools.git.executable)
}
