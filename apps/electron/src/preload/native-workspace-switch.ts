/** Keep native window binding and WS routing changes in the same request order. */
export function createNativeWorkspaceSwitcher(perform: (workspaceId: string) => Promise<void>) {
  let tail: Promise<void> = Promise.resolve()
  return (workspaceId: string): Promise<void> => {
    const result = tail.then(() => perform(workspaceId))
    tail = result.catch(() => {})
    return result
  }
}
