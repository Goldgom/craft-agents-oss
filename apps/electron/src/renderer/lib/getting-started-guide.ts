export const GETTING_STARTED_GUIDE_VERSION = 1

/**
 * Versioning lets a future, materially different guide be shown once without
 * making the current guide reappear on every launch.
 */
export function shouldShowGettingStartedGuide(completedVersion: unknown): boolean {
  return typeof completedVersion !== 'number'
    || completedVersion < GETTING_STARTED_GUIDE_VERSION
}
