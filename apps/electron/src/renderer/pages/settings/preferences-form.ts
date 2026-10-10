export interface PreferencesFormState {
  name: string
  timezone: string
  preferredProxy: string
  city: string
  country: string
  notes: string
}

export const emptyFormState: PreferencesFormState = {
  name: '',
  timezone: '',
  preferredProxy: '',
  city: '',
  country: '',
  notes: '',
}

export function parsePreferences(json: string): PreferencesFormState {
  try {
    const prefs = JSON.parse(json)
    const text = (value: unknown) => typeof value === 'string' ? value : ''
    return {
      name: text(prefs.name),
      timezone: text(prefs.timezone),
      preferredProxy: text(prefs.preferredProxy),
      city: text(prefs.location?.city),
      country: text(prefs.location?.country),
      notes: text(prefs.notes),
    }
  } catch {
    return { ...emptyFormState }
  }
}

export function serializePreferences(state: PreferencesFormState, existingJson: string): string {
  const prefs = JSON.parse(existingJson) as Record<string, unknown>
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    throw new Error('Preferences must be a JSON object')
  }

  for (const field of ['name', 'timezone', 'preferredProxy', 'notes'] as const) {
    const value = field === 'preferredProxy' ? state[field].trim() : state[field]
    if (value) prefs[field] = value
    else delete prefs[field]
  }

  const location = prefs.location && typeof prefs.location === 'object' && !Array.isArray(prefs.location)
    ? { ...prefs.location as Record<string, unknown> }
    : {}
  for (const field of ['city', 'country'] as const) {
    if (state[field]) location[field] = state[field]
    else delete location[field]
  }
  if (Object.keys(location).length > 0) prefs.location = location
  else delete prefs.location

  prefs.updatedAt = Date.now()
  return JSON.stringify(prefs, null, 2)
}
