import * as React from 'react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { Copy, FolderOpen } from 'lucide-react'
import { defaultUrlTransform } from 'react-markdown'
import { useTranslation } from 'react-i18next'
import { usePlatform } from '../../context/PlatformContext'
import { resolveMarkdownLinkTarget } from './link-target'

interface MarkdownLinkProps {
  href?: string
  children?: React.ReactNode
  onUrlClick?: (url: string) => void
  onFileClick?: (path: string) => void
}

const menuItemClasses = 'relative flex cursor-default items-center gap-2 px-2 py-1.5 text-sm outline-hidden select-none rounded-[4px] data-[highlighted]:bg-foreground/[0.03] [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0'

/** File actions use the original target; DOM hrefs remain sanitized. */
export function MarkdownLink({ href, children, onUrlClick, onFileClick }: MarkdownLinkProps) {
  const { t } = useTranslation()
  const { onRevealInFinder, onCopyToClipboard } = usePlatform()
  const trimmedHref = href?.trim() ?? ''
  const safeHref = trimmedHref ? defaultUrlTransform(trimmedHref) || undefined : undefined
  // Raw HTML anchors can omit href and contain a path as their text instead.
  const fallbackText = React.Children.toArray(children)
    .map(child => typeof child === 'string' ? child : '')
    .join('')
    .trim()
  const target = trimmedHref || fallbackText
  const resolvedTarget = target ? resolveMarkdownLinkTarget(target) : undefined

  const anchor = (
    <a
      href={safeHref}
      onClick={event => {
        event.preventDefault()
        if (resolvedTarget?.kind === 'file') {
          onFileClick?.(resolvedTarget.path)
        } else if (resolvedTarget?.kind === 'url') {
          onUrlClick?.(resolvedTarget.url)
        }
      }}
      className="text-accent hover:underline cursor-pointer"
    >
      {children}
    </a>
  )

  // Leave web links and empty anchors unchanged, including their native menu.
  if (resolvedTarget?.kind !== 'file') return anchor
  const filePath = resolvedTarget.path
  const handleCopy = async () => {
    try {
      if (onCopyToClipboard) {
        await onCopyToClipboard(filePath)
      } else {
        await navigator.clipboard.writeText(filePath)
      }
    } catch (error) {
      console.error('Failed to copy file address:', error)
    }
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{anchor}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="popover-styled z-dropdown min-w-40 overflow-hidden p-1 w-fit font-sans whitespace-nowrap text-xs flex flex-col gap-0.5 animate-in fade-in-0 zoom-in-95"
          onClick={event => event.stopPropagation()}
          onContextMenu={event => event.stopPropagation()}
        >
          {onRevealInFinder && (
            <ContextMenu.Item className={menuItemClasses} onSelect={() => onRevealInFinder(filePath)}>
              <FolderOpen />
              {t('common.openFileLocation')}
            </ContextMenu.Item>
          )}
          <ContextMenu.Item className={menuItemClasses} onSelect={() => { void handleCopy() }}>
            <Copy />
            {t('common.copyAddress')}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}