import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'
import { cn } from '@/lib/utils'

export type WorkbenchSelectOption = { value: string | number; label: ReactNode; disabled?: boolean }

/** Theme-aware menus shared by the canvas, mind map and agent editors. */
export function WorkbenchSelect({ value, options, onValueChange, className, placeholder, disabled, id, ...labelProps }: {
  value: string | number | undefined
  options: WorkbenchSelectOption[]
  onValueChange: (value: string) => void
  className?: string
  placeholder?: string
  disabled?: boolean
  id?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
}) {
  const { t } = useTranslation()
  // Prefix every value: Radix reserves an empty string for clearing the selection.
  const encode = (raw: string | number) => `value:${raw}`
  const selected = options.find(option => String(option.value) === String(value))
  return <Select value={selected ? encode(selected.value) : ''} onValueChange={encoded => onValueChange(encoded.slice(6))} disabled={disabled}>
    <SelectTrigger id={id} {...labelProps} className={cn(
      'h-9 min-w-0 gap-2 rounded-lg border-input bg-background px-3 text-xs shadow-xs transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 data-[state=open]:border-primary/50 data-[state=open]:ring-2 data-[state=open]:ring-primary/15 [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0',
      className,
    )} title={typeof selected?.label === 'string' ? selected.label : undefined}>
      <SelectValue placeholder={placeholder ?? options.find(option => option.value === '')?.label ?? t('common.chooseOption')} />
    </SelectTrigger>
    <SelectContent className="z-floating-menu max-h-[min(320px,var(--radix-select-content-available-height))] max-w-[min(480px,calc(100vw-24px))] rounded-xl border border-border/80 bg-popover p-1 shadow-strong" collisionPadding={12}>
      {options.map(option => <SelectItem key={String(option.value)} value={encode(option.value)} disabled={option.disabled}
        className="min-h-9 rounded-lg py-2 pl-2.5 pr-8 text-xs leading-5 focus:bg-primary/10 focus:text-foreground data-[state=checked]:bg-primary/10 data-[state=checked]:text-primary [&>span:last-child]:break-words">
        {option.label}
      </SelectItem>)}
    </SelectContent>
  </Select>
}
