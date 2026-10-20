/** Scroll only the message viewport. scrollIntoView also scrolls outer panels
 * and hidden overflow ancestors, which can displace a floating chat window. */
export function scrollChatViewport(
  viewport: HTMLElement | null,
  options: { behavior?: ScrollBehavior; target?: HTMLElement; block?: 'center' | 'end' } = {},
): void {
  if (!viewport) return
  const { behavior = 'instant', target, block = 'end' } = options
  let top = viewport.scrollHeight
  if (target) {
    const viewportRect = viewport.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const targetTop = viewport.scrollTop + targetRect.top - viewportRect.top - viewport.clientTop
    top = block === 'center'
      ? targetTop + (targetRect.height - viewport.clientHeight) / 2
      : targetTop + targetRect.height - viewport.clientHeight
  }
  viewport.scrollTo({ top, behavior })
}
