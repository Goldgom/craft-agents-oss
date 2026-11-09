import { Children, Fragment, isValidElement, type ReactNode } from 'react'
import { WorkbenchSelect, type WorkbenchSelectOption } from '@/components/ui/workbench-select'

type OptionProps = { value?: string | number; disabled?: boolean; children?: ReactNode }

/** Declarative options with the same value semantics as the existing forms, without native OS menus. */
export function SuperAgentSelect({ children, value, onChange, ...props }: {
  children: ReactNode
  value?: string | number
  onChange: (event: { target: { value: string } }) => void
  className?: string
  disabled?: boolean
  id?: string
  'aria-label'?: string
}) {
  const options = superAgentSelectOptions(children)
  return <WorkbenchSelect {...props} value={value} options={options} onValueChange={value => onChange({ target: { value } })} />
}

export function superAgentSelectOptions(children: ReactNode): WorkbenchSelectOption[] {
  const options: WorkbenchSelectOption[] = []
  function collect(nodes: ReactNode) {
    Children.forEach(nodes, child => {
      if (!isValidElement<OptionProps>(child)) return
      if (child.type === Fragment) collect(child.props.children)
      else if (child.type === 'option') options.push({
        value: child.props.value ?? String(child.props.children ?? ''),
        label: child.props.children,
        disabled: child.props.disabled,
      })
    })
  }
  collect(children)
  return options
}
