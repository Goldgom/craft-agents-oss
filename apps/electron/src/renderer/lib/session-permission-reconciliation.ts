/** Keep bulk permission reads below the native transport's pending RPC limit. */
export async function reconcileSessionPermissionModes(
  sessions: readonly { id: string }[],
  reconcile: (sessionId: string) => Promise<void>,
  isCurrent: () => boolean,
): Promise<void> {
  let nextIndex = 0
  const worker = async () => {
    while (isCurrent() && nextIndex < sessions.length) {
      const session = sessions[nextIndex++]!
      try { await reconcile(session.id) }
      catch { /* One failed read must not prevent the remaining sessions from syncing. */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, sessions.length) }, worker))
}
