export const AUTO_CAPITALISATION_CHANGE_EVENT = 'craft:auto-capitalisation-change'

export function dispatchAutoCapitalisationChange(enabled: boolean): void {
  window.dispatchEvent(new CustomEvent<boolean>(AUTO_CAPITALISATION_CHANGE_EVENT, {
    detail: enabled,
  }))
}
