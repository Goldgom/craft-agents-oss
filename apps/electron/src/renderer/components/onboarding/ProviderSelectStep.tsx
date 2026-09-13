import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { Bird, Key, Monitor, Settings2 } from "lucide-react"
import { Spinner } from "@craft-agent/ui"
import { CraftAgentsSymbol } from "@/components/icons/CraftAgentsSymbol"
import { BackButton, StepFormLayout } from "./primitives"

import claudeIcon from "@/assets/provider-icons/claude.svg"
import openaiIcon from "@/assets/provider-icons/openai.svg"
import copilotIcon from "@/assets/provider-icons/copilot.svg"

/**
 * The high-level provider choice the user makes on first launch.
 * This maps to one or more ApiSetupMethods downstream.
 */
export type ProviderChoice = 'tokennest' | 'other' | 'claude' | 'chatgpt' | 'copilot' | 'api_key' | 'local'

interface ProviderOption {
  id: ProviderChoice
  name: string
  description: string
  icon: React.ReactNode
}

const PROVIDER_ICONS: Record<ProviderChoice, React.ReactNode> = {
  tokennest: <Bird className="size-5" />,
  other: <Settings2 className="size-5" />,
  claude: <img src={claudeIcon} alt="" className="size-5 rounded-[3px]" />,
  chatgpt: <img src={openaiIcon} alt="" className="size-5 rounded-[3px]" />,
  copilot: <img src={copilotIcon} alt="" className="size-5 rounded-[3px]" />,
  api_key: <Key className="size-5" />,
  local: <Monitor className="size-5" />,
}

interface ProviderSelectStepProps {
  /** Called when the user selects a provider */
  onSelect: (choice: ProviderChoice) => void
  /** Called when the user chooses to skip setup */
  onSkip?: () => void
  /** Primary TokenNest choice or the secondary list of direct providers. */
  variant?: 'primary' | 'other'
  /** Called from the secondary provider list. */
  onBack?: () => void
  status?: 'idle' | 'validating' | 'success' | 'error'
  errorMessage?: string
}

/**
 * ProviderSelectStep — First screen after install.
 *
 * Welcomes the user and asks them to pick their subscription / auth method.
 * Selecting a card immediately advances to the next step.
 */
export function ProviderSelectStep({
  onSelect,
  onSkip,
  variant = 'primary',
  onBack,
  status = 'idle',
  errorMessage,
}: ProviderSelectStepProps) {
  const { t } = useTranslation()

  const primaryOptions: ProviderOption[] = [
    {
      id: 'tokennest',
      name: t("settings.ai.tokenNestSignIn"),
      description: t("settings.ai.tokenNestDescription"),
      icon: PROVIDER_ICONS.tokennest,
    },
    {
      id: 'other',
      name: t("onboarding.providerSelect.otherProvider"),
      description: t("onboarding.providerSelect.otherProviderDesc"),
      icon: PROVIDER_ICONS.other,
    },
  ]

  const otherProviderOptions: ProviderOption[] = [
    {
      id: 'claude',
      name: t("onboarding.providerSelect.claudeProMax"),
      description: t("onboarding.providerSelect.claudeProMaxDesc"),
      icon: PROVIDER_ICONS.claude,
    },
    {
      id: 'chatgpt',
      name: t("onboarding.providerSelect.codexChatGPT"),
      description: t("onboarding.providerSelect.codexChatGPTDesc"),
      icon: PROVIDER_ICONS.chatgpt,
    },
    {
      id: 'copilot',
      name: t("onboarding.providerSelect.githubCopilot"),
      description: t("onboarding.providerSelect.githubCopilotDesc"),
      icon: PROVIDER_ICONS.copilot,
    },
    {
      id: 'api_key',
      name: t("onboarding.apiSetup.apiKey"),
      description: 'Anthropic, AWS Bedrock, OpenRouter, Google or any compatible provider.',
      icon: PROVIDER_ICONS.api_key,
    },
    {
      id: 'local',
      name: t("onboarding.providerSelect.localModel"),
      description: 'Run models locally with Ollama.',
      icon: PROVIDER_ICONS.local,
    },
  ]
  const providerOptions = variant === 'primary' ? primaryOptions : otherProviderOptions
  const isTokenNestPending = status === 'validating'

  return (
    <StepFormLayout
      iconElement={
        <div className="flex size-16 items-center justify-center">
          <CraftAgentsSymbol className="size-10 text-accent" />
        </div>
      }
      title={t(variant === 'primary' ? "onboarding.providerSelect.title" : "onboarding.providerSelect.otherTitle")}
      description={t(variant === 'primary' ? "onboarding.providerSelect.description" : "onboarding.providerSelect.otherDescription")}
      actions={variant === 'other' && onBack ? <BackButton onClick={onBack} /> : undefined}
    >
      <div className="space-y-2 sm:space-y-3">
        {providerOptions.map((option) => (
          <button
            key={option.id}
            onClick={() => onSelect(option.id)}
            disabled={isTokenNestPending}
            className={cn(
              "flex w-full items-center gap-3 rounded-xl bg-foreground-2 p-3 text-left transition-all",
              "sm:items-start sm:gap-4 sm:p-4",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "hover:bg-foreground/[0.02] shadow-minimal",
              "disabled:cursor-wait disabled:opacity-60",
            )}
          >
            {/* Icon */}
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              {isTokenNestPending && option.id === 'tokennest' ? <Spinner /> : option.icon}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <span className="font-medium text-sm">{option.name}</span>
              <p className="mt-0 hidden sm:block text-xs text-muted-foreground">
                {option.description}
              </p>
            </div>
          </button>
        ))}
      </div>

      {status === 'error' && errorMessage && (
        <div className="mt-3 rounded-lg bg-destructive/10 p-3 text-center text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      {variant === 'primary' && onSkip && (
        <div className="mt-4 text-center">
          <button
            onClick={onSkip}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("onboarding.providerSelect.setupLater")}
          </button>
        </div>
      )}
    </StepFormLayout>
  )
}
