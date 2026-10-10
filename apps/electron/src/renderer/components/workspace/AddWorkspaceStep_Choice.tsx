import { useTranslation } from "react-i18next"
import { ArrowRight, FolderPlus, FolderOpen } from "lucide-react"
import { cn } from "@/lib/utils"
import { AddWorkspaceContainer, AddWorkspaceStepHeader } from "./primitives"

interface AddWorkspaceStep_ChoiceProps {
  onCreateNew: () => void
  onOpenFolder: () => void
}

interface ChoiceCardProps {
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
  variant?: 'primary' | 'secondary'
}

function ChoiceCard({ icon, title, description, onClick, variant = 'secondary' }: ChoiceCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-4 rounded-xl border px-5 py-5 text-left sm:px-6 sm:py-6",
        "transition-colors duration-150",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        variant === 'primary'
          ? "border-foreground bg-foreground text-background hover:bg-foreground/90"
          : "border-foreground/10 bg-transparent text-foreground hover:border-foreground/20 hover:bg-foreground/[0.03]"
      )}
    >
      <div className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center",
        variant === 'primary'
          ? "text-background/80"
          : "text-muted-foreground"
      )}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium leading-6">{title}</div>
        <div className={cn(
          "mt-1 text-sm leading-relaxed",
          variant === 'primary' ? "text-background/65" : "text-muted-foreground"
        )}>{description}</div>
      </div>
      <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 opacity-40 group-hover:opacity-80" />
    </button>
  )
}

/**
 * AddWorkspaceStep_Choice - Initial step to choose creation method
 *
 * Two options:
 * 1. Create new workspace - Creates a fresh workspace folder
 * 2. Open folder as workspace - Use an existing folder
 */
export function AddWorkspaceStep_Choice({
  onCreateNew,
  onOpenFolder,
}: AddWorkspaceStep_ChoiceProps) {
  const { t } = useTranslation()
  return (
    <AddWorkspaceContainer>
      <AddWorkspaceStepHeader
        title={t("workspace.addWorkspace")}
        description={t("workspace.addWorkspaceDesc")}
      />

      <div className="mt-10 w-full space-y-3">
        <ChoiceCard
          icon={<FolderPlus className="h-5 w-5" />}
          title={t("workspace.createNew")}
          description={t("workspace.createNewDesc")}
          onClick={onCreateNew}
          variant="primary"
        />

        <ChoiceCard
          icon={<FolderOpen className="h-5 w-5" />}
          title={t("workspace.openFolder")}
          description={t("workspace.openFolderDesc")}
          onClick={onOpenFolder}
        />
      </div>
    </AddWorkspaceContainer>
  )
}
