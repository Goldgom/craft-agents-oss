/**
 * Slugify utility for workspace names
 *
 * Converts a human-readable name into a filesystem-safe slug.
 * Example: "My Project" → "my-project"
 */

/**
 * Convert a string to a URL/filesystem-safe slug
 * - Lowercase
 * - Replace spaces and underscores with hyphens
 * - Remove non-letter/non-number characters (except hyphens)
 * - Collapse multiple hyphens
 * - Trim leading/trailing hyphens
 */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    // Replace spaces and underscores with hyphens
    .replace(/[\s_]+/g, '-')
    // Keep Unicode letters and numbers (e.g. Chinese workspace names) while
    // removing punctuation and other characters that are unsafe in a folder
    // name. Unicode property escapes are supported by the app's target runtimes.
    .replace(/[^\p{L}\p{N}-]/gu, '')
    // Collapse multiple hyphens into one
    .replace(/-+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-|-$/g, '')
}

/**
 * Check if a string is a valid slug (already slugified)
 */
export function isValidSlug(str: string): boolean {
  return /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(str)
}
