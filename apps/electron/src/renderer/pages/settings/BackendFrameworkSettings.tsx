import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, Download, Loader2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { SettingsCard, SettingsSection } from '@/components/settings';
import { getAgentPluginDescriptor, setAgentPluginCatalog } from '@tokenbird/shared/agent-plugins/catalog';
import { defaultFrameworkConfiguration, defaultNativeOptions, FRAMEWORK_FEATURES, frameworkFeatureOptions, getAgentFrameworkProfile, nativeCodexTransportCompatible,
  type BackendFrameworkCatalog, type BackendFrameworkConfiguration, type BackendFrameworkEntry,
  type BackendFrameworkTestResult, type FrameworkInstallProgress } from '@tokenbird/shared/agent-plugins/frameworks';
import type { AgentRuntimeSelection, LlmConnection } from '@config/llm-connections';
import { AgentPluginInstaller } from './AgentPluginInstaller';

const prefix = 'settings.ai.frameworks.';
const frameworkKeys: Record<string, string> = { pi: 'pi', codex: 'codex', 'claude-code': 'claude', 'plugin:hermes': 'hermes', 'plugin:dsh': 'dsh' };

export function agentRuntimeLabel(runtime: AgentRuntimeSelection, t: (key: string) => string): string {
  if (runtime === 'auto') return t('settings.ai.runtime.auto');
  return getAgentPluginDescriptor(runtime)?.name ?? t(`${prefix}unavailable`);
}

export function agentRuntimeDescription(runtime: AgentRuntimeSelection, t: (key: string) => string): string {
  if (runtime === 'auto') return t('settings.ai.runtime.autoDescription');
  const key = frameworkKeys[runtime];
  return key ? t(`${prefix}descriptions.${key}`) : getAgentPluginDescriptor(runtime)?.description ?? t(`${prefix}unavailable`);
}

export function AgentFrameworkDetails({ runtime, connection }: { runtime: AgentRuntimeSelection; connection?: LlmConnection }) {
  const { t } = useTranslation();
  const profile = runtime === 'auto' ? undefined : getAgentFrameworkProfile(runtime);
  if (!profile) return <p className="text-xs text-muted-foreground">{agentRuntimeDescription(runtime, t)}</p>;
  return <div className="space-y-2 text-xs leading-5" data-framework-details={runtime}>
    {(['strengths', 'bestFor', 'limits'] as const).map(field => <p key={field}>
      <span className="font-medium text-foreground">{t(`${prefix}guide.${field}`)}: </span>
      <span className="text-muted-foreground">{t(`${prefix}profiles.${profile.key}.${field}`)}</span>
    </p>)}
    {runtime === 'codex' && connection && !nativeCodexTransportCompatible(connection) &&
      <p className="rounded-md bg-muted p-2 text-muted-foreground">{t(`${prefix}codexCompatibility`)}</p>}
  </div>;
}

function FrameworkRow({ framework, onSaved }: { framework: BackendFrameworkEntry; onSaved: () => Promise<void> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<BackendFrameworkConfiguration>(framework.configuration);
  const [busy, setBusy] = useState<'save' | 'test' | 'install' | 'connection' | null>(null);
  const antigravityExecutable = draft.executablePath || framework.detectedLocation?.executablePath;
  const antigravityLogin = antigravityExecutable
    ? /^[A-Za-z]:[\\/]/.test(antigravityExecutable) ? `& '${antigravityExecutable.replaceAll("'", "''")}' acp --login`
      : `'${antigravityExecutable.replaceAll("'", "'\\''")}' acp --login`
    : 'agy acp --login';
  const [progress, setProgress] = useState<FrameworkInstallProgress | null>(null);
  const [result, setResult] = useState<BackendFrameworkTestResult | null>(null);
  const [feedback, setFeedback] = useState('');
  const [failed, setFailed] = useState(false);
  const stored = JSON.stringify(framework.configuration);
  const previousStored = useRef(stored);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirty = JSON.stringify(draft) !== stored;
  useEffect(() => {
    const current = JSON.stringify(draftRef.current);
    if (current === previousStored.current || current === stored) {
      setDraft(framework.configuration);
      if (current !== stored) setResult(null);
    }
    previousStored.current = stored;
  }, [stored]);

  const update = (value: Partial<BackendFrameworkConfiguration>) => {
    setDraft(previous => ({ ...previous, ...value })); setResult(null); setFeedback(''); setFailed(false);
  };
  const external = !framework.builtin;
  const native = draft.nativeOptions ?? defaultNativeOptions();
  useEffect(() => window.electronAPI.onBackendFrameworkInstallProgress?.(value => {
    if (value.id === framework.id) setProgress(value);
  }), [framework.id]);
  const needsProject = framework.id === 'plugin:hermes';
  const status = !framework.enabled && !framework.setupRequired ? 'disabled' : result ? (result.success ? 'valid' : 'invalid')
    : framework.setupRequired || framework.installation?.available === false ? 'notConfigured'
    : framework.builtin && !draft.executablePath && !draft.entrypointPath ? 'bundled' : 'configured';

  async function run(action: 'save' | 'test') {
    setBusy(action); setFeedback(''); setFailed(false);
    try {
      if (action === 'test') setResult(await window.electronAPI.testBackendFramework(draft));
      else {
        await window.electronAPI.saveBackendFramework(draft);
        setDraft({ ...draft, executablePath: draft.executablePath.trim(), entrypointPath: draft.entrypointPath.trim(), projectPath: draft.projectPath.trim() });
        await onSaved(); setFeedback(t(`${prefix}saved`));
      }
    } catch (error) { setFailed(true); setFeedback(error instanceof Error ? error.message : t(`${prefix}failed`)); }
    finally { setBusy(null); }
  }

  async function addAntigravityConnection() {
    setBusy('connection'); setFeedback(''); setFailed(false);
    try {
      const connections = await window.electronAPI.listLlmConnections();
      if (!connections.some(connection => connection.agentRuntime === 'plugin:antigravity')) {
        const now = Date.now();
        const result = await window.electronAPI.saveLlmConnection({
          slug: `antigravity-${crypto.randomUUID()}`, name: framework.name,
          providerType: 'pi', piAuthProvider: 'google', authType: 'none', agentRuntime: 'plugin:antigravity',
          models: ['antigravity-auto'], defaultModel: 'antigravity-auto', createdAt: now,
        });
        if (!result.success) throw new Error(result.error || t(`${prefix}failed`));
      }
      await onSaved();
      setFeedback(t(`${prefix}antigravity.connectionReady`));
    } catch (error) { setFailed(true); setFeedback(error instanceof Error ? error.message : t(`${prefix}failed`)); }
    finally { setBusy(null); }
  }

  async function install() {
    setBusy('install'); setResult(null); setFeedback(''); setFailed(false); setProgress({ id: framework.id, phase: 'preparing' });
    try {
      const installed = await window.electronAPI.installBackendFramework(framework.id, framework.id === 'plugin:antigravity' ? 'official' : draft.downloadSource ?? 'official');
      if (!installed.success || !installed.configuration) throw new Error(installed.error || t(`${prefix}installFailed`));
      // Keep unsaved feature choices while adopting the verified executable paths.
      setDraft({ ...installed.configuration, features: draft.features, ...(draft.nativeOptions ? { nativeOptions: draft.nativeOptions } : {}) });
      setResult(installed.test ?? null); await onSaved(); setFeedback(t(`${prefix}installed`));
    } catch (error) { setFailed(true); setFeedback(error instanceof Error ? error.message : t(`${prefix}installFailed`)); }
    finally { setBusy(null); setProgress(null); }
  }

  return <div className="border-b border-border/50 last:border-0" data-framework={framework.id}>
    <button type="button" className="flex w-full items-center gap-3 px-4 py-4 text-left hover:bg-muted/30"
      aria-expanded={open} aria-controls={`framework-${framework.id.replace(':', '-')}`} onClick={() => setOpen(value => !value)}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><span className="text-sm font-medium">{framework.name}</span>
          <span className={`rounded px-2 py-0.5 text-xs ${status === 'invalid' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}>{t(`${prefix}status.${status}`)}</span>
          {dirty && <span className="text-xs text-muted-foreground">{t(`${prefix}unsaved`)}</span>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{agentRuntimeDescription(framework.id, t)}</p>
      </div>
      <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div id={`framework-${framework.id.replace(':', '-')}`} className="space-y-5 border-t border-border/50 px-4 py-4">
      <AgentFrameworkDetails runtime={framework.id} />
      {framework.id === 'plugin:antigravity' && <div className="space-y-2 text-xs text-muted-foreground">
        <p>{t(`${prefix}antigravity.loginHelp`)}</p>
        <code className="block select-all break-all">{antigravityLogin}</code>
        <Button size="sm" variant="outline" disabled={!!busy || !framework.enabled} onClick={() => void addAntigravityConnection()}>
          {t('settings.ai.addConnection')}
        </Button>
      </div>}

      {framework.installation?.installable && <div className="space-y-2">
        <div className="flex items-center gap-2">
          {framework.id !== 'plugin:antigravity' && <label className="flex items-center gap-2 text-xs text-muted-foreground">{t(`${prefix}downloadSource`)}
            <select value={draft.downloadSource ?? 'official'} disabled={!!busy} aria-label={`${framework.name} ${t(`${prefix}downloadSource`)}`}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              onChange={event => update({ downloadSource: event.target.value as 'official' | 'mirror' })}>
              <option value="official">{t(`${prefix}downloadOfficial`)}</option><option value="mirror">{t(`${prefix}downloadMirror`)}</option>
            </select>
          </label>}
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void install()}>
            {busy === 'install' ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Download className="mr-1 size-3" />}
            {t(`${prefix}${framework.installation.available ? 'reinstall' : 'install'}`)}
          </Button>
          {busy === 'install' && <Button size="sm" variant="ghost" onClick={() => { void window.electronAPI.cancelBackendFrameworkInstall(framework.id).catch(() => {}); }}>{t(`${prefix}cancelInstall`)}</Button>}
        </div>
        <p className="text-xs text-muted-foreground">{t(`${prefix}installHelp`)}</p>
        {busy === 'install' && progress && <p role="status" className="text-xs text-muted-foreground">{t(`${prefix}installPhase.${progress.phase}`)}</p>}
      </div>}
      <div className="space-y-3">
        <h4 className="text-sm font-medium">{t(`${prefix}location`)}</h4>
        <p className="text-xs text-muted-foreground">{t(`${prefix}locationHelp`)}</p>
        <label className="block space-y-1 text-xs text-muted-foreground">
          <span>{t(`${prefix}${framework.id === 'pi' ? 'bunPath' : external && framework.id !== 'plugin:antigravity' ? 'pythonPath' : 'executablePath'}`)}</span>
          <input aria-label={`${framework.name} ${t(`${prefix}executablePath`)}`} value={draft.executablePath}
            onChange={event => update({ executablePath: event.target.value })} disabled={!!busy}
            placeholder={framework.detectedLocation?.executablePath || t(`${prefix}${external && framework.id !== 'plugin:antigravity' ? 'pythonPlaceholder' : 'automatic'}`)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" />
        </label>
        {!external && <p className="text-xs text-muted-foreground">{t(`${prefix}automaticHelp`)}</p>}
        {framework.id === 'pi' && <label className="block space-y-1 text-xs text-muted-foreground">
          <span>{t(`${prefix}piEntrypoint`)}</span>
          <input aria-label={t(`${prefix}piEntrypoint`)} value={draft.entrypointPath} disabled={!!busy}
            onChange={event => update({ entrypointPath: event.target.value })}
            placeholder={framework.detectedLocation?.entrypointPath || t(`${prefix}automatic`)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" />
          <span className="block">{t(`${prefix}piHelp`)}</span>
        </label>}
        {needsProject && <label className="block space-y-1 text-xs text-muted-foreground">
          <span>{t(`${prefix}projectPath`)}</span>
          <input aria-label={t(`${prefix}projectPath`)} value={draft.projectPath} disabled={!!busy}
            onChange={event => update({ projectPath: event.target.value })}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" />
        </label>}
        {framework.id === 'plugin:dsh' && <p className="text-xs text-muted-foreground">{t(`${prefix}dshHelp`)}</p>}
        {needsProject && <p className="text-xs text-muted-foreground">{t(`${prefix}hermesHelp`)}</p>}
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-medium">{t(`${prefix}nativeTitle`)}</h4>
        <p className="text-xs text-muted-foreground">{t(`${prefix}nativeHelp.${frameworkKeys[framework.id] ?? 'other'}`)}</p>
        {needsProject && <>
          {(['projectInstructions', 'skills', 'memory'] as const).map(key => <label key={key} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={native[key]} disabled={!!busy} aria-label={t(`${prefix}native.${key}`)}
              onChange={event => update({ nativeOptions: { ...native, [key]: event.target.checked } })} />{t(`${prefix}native.${key}`)}
          </label>)}
          <label className="block space-y-1 text-xs text-muted-foreground"><span>{t(`${prefix}native.toolsets`)}</span>
            <input value={native.toolsets.join(', ')} disabled={!!busy} aria-label={t(`${prefix}native.toolsets`)}
              placeholder={t(`${prefix}native.toolsetsPlaceholder`)} onChange={event => update({ nativeOptions: { ...native, toolsets: event.target.value.split(',').map(value => value.trim()).filter(Boolean) } })}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" />
          </label>
        </>}
        {framework.id === 'plugin:dsh' && <label className="block space-y-1 text-xs text-muted-foreground"><span>{t(`${prefix}native.profile`)}</span>
          <input value={native.profile} disabled={!!busy} aria-label={t(`${prefix}native.profile`)}
            onChange={event => update({ nativeOptions: { ...native, profile: event.target.value } })}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" />
        </label>}
        {framework.id === 'claude-code' && <div className="space-y-2">
          <h4 className="text-sm font-medium">{t('settings.backends.claudeTitle')}</h4>
          <p className="text-xs text-muted-foreground">{t('settings.backends.claudeHelp')}</p>
          {(native.claudePlugins ?? []).map((path, index) => <div key={index} className="flex items-center gap-2">
            <input value={path} disabled={!!busy} aria-label={`${t('settings.backends.pluginPath')} ${index + 1}`}
              onChange={event => update({ nativeOptions: { ...native, claudePlugins: (native.claudePlugins ?? []).map((value, i) => i === index ? event.target.value : value) } })}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm" />
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => update({ nativeOptions: { ...native, claudePlugins: native.claudePlugins!.filter((_, i) => i !== index) } })}>{t('settings.backends.removePlugin')}</Button>
          </div>)}
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => update({ nativeOptions: { ...native, claudePlugins: [...(native.claudePlugins ?? []), ''] } })}>{t('settings.backends.addPlugin')}</Button>
        </div>}
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-medium">{t(`${prefix}implementations`)}</h4>
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => update({ features: defaultFrameworkConfiguration(framework).features })}>{t(`${prefix}resetFeatures`)}</Button>
        </div>
        <p className="text-xs text-muted-foreground">{t(`${prefix}implementationsHelp`)}</p>
        <div className="divide-y divide-border/50 rounded-md border border-border/50">
          {FRAMEWORK_FEATURES.map(feature => {
            const options = frameworkFeatureOptions(framework, feature);
            return <div key={feature} className="flex items-center justify-between gap-4 px-3 py-2.5">
              <div className="min-w-0"><p className="text-sm">{t(`${prefix}features.${feature}`)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{t(`${prefix}featureHelp.${feature}`)}</p></div>
              <select className="w-36 shrink-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                aria-label={`${framework.name} ${t(`${prefix}features.${feature}`)}`} value={draft.features[feature]} disabled={!!busy || options.length === 1}
                onChange={event => update({ features: { ...draft.features, [feature]: event.target.value } })}>
                {options.map(option => <option key={option} value={option}>{t(`${prefix}implementation.${feature === 'steering' && options.length === 1 ? 'unavailable' : option}`)}</option>)}
              </select>
            </div>;
          })}
          <div className="flex items-center justify-between gap-4 px-3 py-2.5"><span className="text-sm">{t(`${prefix}preferencesAndSkills`)}</span><span className="text-xs text-muted-foreground">{t(`${prefix}implementation.host`)}</span></div>
          <div className="flex items-center justify-between gap-4 px-3 py-2.5"><span className="text-sm">{t(`${prefix}approval`)}</span><span className="text-xs text-muted-foreground">{t(`${prefix}${framework.id === 'codex' ? 'approvalNativeAndHost' : 'approvalRequired'}`)}</span></div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!!busy} onClick={() => void run('save')}>{busy === 'save' && <Loader2 className="mr-1 size-3 animate-spin" />}{t(`${prefix}save`)}</Button>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run('test')}>{busy === 'test' && <Loader2 className="mr-1 size-3 animate-spin" />}{t(`${prefix}test`)}</Button>
        {!framework.builtin && !framework.setupRequired && <Button size="sm" variant="ghost" disabled={!!busy}
          onClick={() => { setBusy('save'); void window.electronAPI.setAgentPluginEnabled(framework.id, !framework.enabled).then(onSaved)
            .catch(error => { setFailed(true); setFeedback(String(error)); }).finally(() => setBusy(null)); }}>{t(`${prefix}${framework.enabled ? 'disable' : 'enable'}`)}</Button>}
      </div>
      <p className="text-xs text-muted-foreground">{t(`${prefix}testHelp`)}</p>
      {result && <div role={result.success ? 'status' : 'alert'} className="space-y-1 rounded-md bg-muted/30 p-3 text-xs">
        <p className={result.success ? 'font-medium' : 'font-medium text-destructive'}>{t(`${prefix}${result.success ? 'testPassed' : 'testFailed'}`)}{result.version ? ` · ${result.version}` : ''}</p>
        {result.checks.map((check, index) => <div key={index} className="flex items-start gap-2">
          {check.success ? <CheckCircle2 className="mt-0.5 size-3 shrink-0" /> : <XCircle className="mt-0.5 size-3 shrink-0 text-destructive" />}
          <span>{t(`${prefix}checks.${check.kind}`)}{check.detail ? `：${check.detail}` : ''}</span>
        </div>)}
      </div>}
      {feedback && <p role={failed ? 'alert' : 'status'} className={failed ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{feedback}</p>}
    </div>}
  </div>;
}

export function BackendFrameworkSettings({ workspaceId, onChanged }: { workspaceId?: string | null; onChanged: () => void }) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<BackendFrameworkCatalog>({ frameworks: [], errors: [] });
  const [loadError, setLoadError] = useState(false);
  const [profileFile, setProfileFile] = useState<File | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileFeedback, setProfileFeedback] = useState('');
  const load = useCallback(async () => {
    const value = await window.electronAPI.listBackendFrameworks();
    setAgentPluginCatalog(value.frameworks); setCatalog(value); setLoadError(false); onChanged();
  }, [onChanged]);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const value = await window.electronAPI.listBackendFrameworks();
        if (cancelled) return;
        setAgentPluginCatalog(value.frameworks); setCatalog(value); setLoadError(false); onChanged();
      } catch { if (!cancelled) setLoadError(true); }
    };
    void refresh();
    const unsubscribe = window.electronAPI.onAgentPluginsChanged(() => { void refresh(); });
    return () => { cancelled = true; unsubscribe(); };
  }, [onChanged]);

  async function exportProfile() {
    setProfileBusy(true); setProfileFeedback('');
    try {
      const value = await window.electronAPI.exportAgentProfile(workspaceId ?? undefined);
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'tokenbird-agent-profile.json'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setProfileFeedback(t(`${prefix}profile.failed`)); }
    finally { setProfileBusy(false); }
  }
  async function importProfile() {
    if (!profileFile) return;
    setProfileBusy(true); setProfileFeedback('');
    try {
      if (profileFile.size > 512 * 1024) throw new Error('file too large');
      await window.electronAPI.importAgentProfile(await profileFile.text(), workspaceId ?? undefined);
      setProfileFile(null); setProfileFeedback(t(`${prefix}profile.imported`)); onChanged();
    } catch { setProfileFeedback(t(`${prefix}profile.failed`)); }
    finally { setProfileBusy(false); }
  }

  return <>
    <SettingsSection title={t(`${prefix}title`)} description={t(`${prefix}description`)}>
      <SettingsCard divided={false}>
        {catalog.frameworks.map(framework => <FrameworkRow key={framework.id} framework={framework} onSaved={load} />)}
        {loadError && <div className="space-y-2 p-4"><p role="alert" className="text-xs text-destructive">{t(`${prefix}loadFailed`)}</p><Button size="sm" variant="outline" onClick={() => { void load().catch(() => setLoadError(true)); }}>{t(`${prefix}retry`)}</Button></div>}
        {catalog.errors.length > 0 && <p role="alert" className="p-4 text-xs text-destructive">{t(`${prefix}configurationError`)}</p>}
      </SettingsCard>
    </SettingsSection>
    <AgentPluginInstaller onInstalled={load} />
    <SettingsSection title={t(`${prefix}profile.title`)} description={t(`${prefix}profile.description`)}>
      <SettingsCard><div className="flex flex-wrap items-center gap-3 p-4">
        <Button size="sm" variant="outline" disabled={profileBusy} onClick={() => void exportProfile()}>{t(`${prefix}profile.export`)}</Button>
        <label className="text-xs text-muted-foreground">{t(`${prefix}profile.chooseFile`)}<input type="file" accept=".json,.md,.txt" disabled={profileBusy}
          aria-label={t(`${prefix}profile.chooseFile`)} className="ml-2 max-w-52 text-xs" onChange={event => { setProfileFile(event.target.files?.[0] ?? null); setProfileFeedback(''); }} /></label>
        <Button size="sm" disabled={profileBusy || !profileFile} onClick={() => void importProfile()}>{t(`${prefix}profile.import`)}</Button>
        {profileFeedback && <p role="status" className="w-full text-xs text-muted-foreground">{profileFeedback}</p>}
      </div></SettingsCard>
    </SettingsSection>
  </>;
}
