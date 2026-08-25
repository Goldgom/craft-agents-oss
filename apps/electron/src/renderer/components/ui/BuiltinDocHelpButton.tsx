import * as React from 'react'
import { HelpCircle } from 'lucide-react'
import { DocumentFormattedMarkdownOverlay } from '@craft-agent/ui'
import { getDocUrl, type DocFeature } from '@craft-agent/shared/docs/doc-links'
import { cn } from '@/lib/utils'

interface BuiltinDocHelpButtonProps {
  feature: DocFeature
  docFile?: string
  className?: string
  label?: string
}

/** Opens the bundled Markdown guide, with the public docs as a fallback. */
export function BuiltinDocHelpButton({
  feature,
  docFile = `${feature}.md`,
  className,
  label = 'Help',
}: BuiltinDocHelpButtonProps) {
  const [content, setContent] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)

  const showHelp = async () => {
    setLoading(true)
    try {
      const markdown = await window.electronAPI.readFile(`~/.craft-agent/docs/${docFile}`)
      setContent(markdown)
      setOpen(true)
    } catch {
      await window.electronAPI.openUrl(getDocUrl(feature))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void showHelp()}
        disabled={loading}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-[8px] border border-foreground/10 px-2.5 py-1.5 text-xs font-medium hover:bg-foreground/[0.04] disabled:opacity-50',
          className,
        )}
        title={`${label} documentation`}
      >
        <HelpCircle className="size-3.5" /> {label}
      </button>
      <DocumentFormattedMarkdownOverlay
        isOpen={open}
        onClose={() => setOpen(false)}
        content={content}
        onOpenUrl={(url) => window.electronAPI.openUrl(url)}
      />
    </>
  )
}
