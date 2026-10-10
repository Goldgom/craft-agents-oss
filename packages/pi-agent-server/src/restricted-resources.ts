import { DefaultResourceLoader, type SettingsManager } from '@earendil-works/pi-coding-agent';

/** Worker code must never be loaded as a host extension, including in utility inference. */
export async function restrictedResources(cwd: string, agentDir: string, settingsManager: SettingsManager) {
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => undefined, appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  return loader;
}
