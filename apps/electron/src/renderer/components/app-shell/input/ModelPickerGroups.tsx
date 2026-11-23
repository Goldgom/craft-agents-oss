import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAtomValue } from 'jotai'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { modelGroupExpansionAtom } from '@/atoms/model-picker'
import { Input } from '@/components/ui/input'
import { StyledDropdownMenuItem } from '@/components/ui/styled-dropdown'
import { cn } from '@/lib/utils'
import { groupPickerModels } from './model-picker-helpers'

type ModelGroups = ReturnType<typeof groupPickerModels>

export function ModelPickerSearch({ query, setQuery, menu }: {
  query: string
  setQuery: (query: string) => void
  menu?: boolean
}) {
  const { t } = useTranslation()
  const label = t('apiSetup.searchModels')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!menu) return
    // Move focus after the dropdown's focus scope has opened.
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [menu])

  return (
    <div className={cn('px-2 py-1.5', menu && 'sticky top-0 z-10 bg-popover')}>
      <Input
        ref={inputRef}
        type="search"
        aria-label={label}
        placeholder={label}
        value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={menu ? event => {
          if (event.key === 'Escape') return
          // Preserve text editing and IME input inside Radix's typeahead menu.
          event.stopPropagation()
          if (event.nativeEvent.isComposing) return
          if (event.key === 'ArrowDown' || event.key === 'Tab') {
            event.preventDefault()
            event.currentTarget.closest('[role="menu"]')
              ?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')?.focus()
          }
        } : undefined}
      />
    </div>
  )
}

export function ModelPickerGroups({ groups, currentModel, searching, menu, renderModel }: {
  groups: ModelGroups
  currentModel?: string | null
  searching: boolean
  menu?: boolean
  renderModel: (model: ModelGroups[number]['models'][number]) => ReactNode
}) {
  const { t } = useTranslation()
  const policy = useAtomValue(modelGroupExpansionAtom)
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  if (!groups.length && searching) {
    return <div role="status" className="px-3 py-2 text-sm text-muted-foreground">{t('chat.modelPicker.noMatches')}</div>
  }

  return groups.map(({ source, models }) => {
    const hasCurrentModel = models.some(model => (typeof model === 'string' ? model : model.id) === currentModel)
    const open = searching || (overrides[source] ?? (
      policy === 'all-expanded' || (policy !== 'all-collapsed' && hasCurrentModel)
    ))
    const toggle = () => setOverrides(previous => ({ ...previous, [source]: !open }))
    const label = (
      <>
        <ChevronRight className={cn('size-3.5 shrink-0', open && 'rotate-90')} />
        <span>{source === 'other' ? t('chat.modelPicker.otherSource') : source}</span>
        <span className="ml-auto text-xs tabular-nums opacity-60">{models.length}</span>
      </>
    )
    const headerClass = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-muted-foreground'

    return (
      <div key={source} role={menu ? 'group' : undefined}>
        {searching ? (
          <div className={headerClass}>{label}</div>
        ) : menu ? (
          <StyledDropdownMenuItem
            aria-expanded={open}
            className={headerClass}
            onSelect={event => {
              event.preventDefault()
              toggle()
            }}
          >
            {label}
          </StyledDropdownMenuItem>
        ) : (
          <button type="button" aria-expanded={open} className={cn(headerClass, 'hover:bg-foreground/5')} onClick={toggle}>
            {label}
          </button>
        )}
        {open && <div className="pl-3">{models.map(renderModel)}</div>}
      </div>
    )
  })
}
