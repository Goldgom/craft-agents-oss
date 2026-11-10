// Dynamic imports are removed from ordinary WebUI/Android builds by Vite.
if (import.meta.env.IS_WIN7_CLIENT) {
  await import('core-js/actual')
  const { installLegacyColors } = await import('./compat/win7-runtime')
  await installLegacyColors()
}

export {}
