import * as RSelect from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'

export interface Option {
  value: string
  label: string
  disabled?: boolean
}

export interface OptionGroup {
  label: string
  options: Option[]
}

type Item = Option | OptionGroup
const isGroup = (i: Item): i is OptionGroup => 'options' in i

/**
 * Glass dropdown built on Radix Select: full keyboard support, typeahead,
 * screen-reader semantics, and a popover that matches the rest of the UI.
 */
export function Select({
  id,
  value,
  onChange,
  items,
  placeholder = 'Choose…',
  label,
  className = '',
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  items: Item[]
  placeholder?: string
  /** Accessible name when no visible <label htmlFor> exists. */
  label?: string
  className?: string
}) {
  const renderItem = (o: Option) => (
    <RSelect.Item
      key={o.value}
      value={o.value}
      disabled={o.disabled}
      className="relative flex cursor-default select-none items-center rounded-lg py-1.5 pl-7 pr-3 text-sm text-text outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent"
    >
      <RSelect.ItemIndicator className="absolute left-2 inline-flex">
        <Check className="size-3.5" aria-hidden />
      </RSelect.ItemIndicator>
      <RSelect.ItemText>{o.label}</RSelect.ItemText>
    </RSelect.Item>
  )

  return (
    // Radix treats "" as "no value"; the placeholder shows instead.
    <RSelect.Root value={value || undefined} onValueChange={onChange}>
      <RSelect.Trigger
        id={id}
        aria-label={label}
        className={`field flex items-center justify-between gap-2 text-left data-[placeholder]:text-muted ${className}`}
      >
        <span className="min-w-0 truncate">
          <RSelect.Value placeholder={placeholder} />
        </span>
        <RSelect.Icon>
          <ChevronDown className="size-4 text-muted" aria-hidden />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={6}
          collisionPadding={8}
          className="glass z-50 max-h-[min(22rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl p-1 rise-in"
          style={{ background: 'var(--tint)' }}
        >
          <RSelect.ScrollUpButton className="flex h-6 items-center justify-center text-muted">
            <ChevronUp className="size-4" aria-hidden />
          </RSelect.ScrollUpButton>
          <RSelect.Viewport>
            {items.map((item, i) =>
              isGroup(item) ? (
                <RSelect.Group key={`g-${i}`}>
                  <RSelect.Label className="hud-label px-2 pb-1 pt-2">{item.label}</RSelect.Label>
                  {item.options.map(renderItem)}
                </RSelect.Group>
              ) : (
                renderItem(item)
              ),
            )}
          </RSelect.Viewport>
          <RSelect.ScrollDownButton className="flex h-6 items-center justify-center text-muted">
            <ChevronDown className="size-4" aria-hidden />
          </RSelect.ScrollDownButton>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  )
}
