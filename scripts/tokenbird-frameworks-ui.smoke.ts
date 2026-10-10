/** Real React + bundled Chinese translations; only host APIs are fixtures. */
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
const domModule = process.env.TOKENBIRD_TEST_DOM_MODULE;
if (!domModule) throw new Error('Set TOKENBIRD_TEST_DOM_MODULE to the optional happy-dom test runtime');
const { Window } = await import(domModule);
const dom = new Window({ url: 'http://tokenbird-framework-ui.test', settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
for (const name of ['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError']) if (!dom[name]) dom[name] = (globalThis as any)[name];
for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLButtonElement', 'DocumentFragment', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle']) {
  const value = name === 'window' ? dom : name === 'document' ? dom.document : dom[name];
  Object.defineProperty(globalThis, name, { value: typeof value === 'function' && /^[a-z]/.test(name) ? value.bind(dom) : value, configurable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { initReactI18next } = await import('react-i18next');
const { setupI18n } = await import('../packages/shared/src/i18n/setupI18n');
await setupI18n([initReactI18next]).changeLanguage('zh-Hans');
const { getAgentPluginCatalog, setAgentPluginCatalog } = await import('../packages/shared/src/agent-plugins/catalog');
const { defaultFrameworkConfiguration } = await import('../packages/shared/src/agent-plugins/frameworks');
const { BackendFrameworkSettings } = await import('../apps/electron/src/renderer/pages/settings/BackendFrameworkSettings');
let root: ReturnType<typeof createRoot>;
let catalog: any;
let api: any;
let notifyChanged: () => void;
async function flush() { await React.act(async () => { await Promise.resolve(); await Bun.sleep(0); }); }
async function click(element: Element) { await React.act(async () => { (element as HTMLElement).click(); }); await flush(); }
async function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  }); await flush();
}
const body = () => document.body.textContent ?? '';
function field(label: string) { const element = document.querySelector(`[aria-label="${label}"]`); if (!element) throw new Error('Missing field: ' + label); return element as HTMLInputElement | HTMLSelectElement; }
function row(id: string) { return document.querySelector(`[data-framework="${id}"]`)!; }
function button(id: string, text: string) { const element = [...row(id).querySelectorAll('button')].find(item => item.textContent === text); if (!element) throw new Error('Missing button: ' + text); return element; }
beforeEach(async () => {
  setAgentPluginCatalog([]);
  catalog = { frameworks: getAgentPluginCatalog().map(framework => ({ ...framework, configuration: defaultFrameworkConfiguration(framework),
    installation: { available: framework.builtin && framework.id !== 'codex', managed: false, installable: true } })), errors: [] };
  api = {
    listBackendFrameworks: mock(async () => structuredClone(catalog)),
    onAgentPluginsChanged: mock((callback: () => void) => { notifyChanged = callback; return () => {}; }),
    testBackendFramework: mock(async () => ({ success: true, checks: [{ kind: 'location', success: true }, { kind: 'runtime', success: true }, { kind: 'protocol', success: true }], version: '1.0.0' })),
    saveBackendFramework: mock(async (draft: any) => { const item = catalog.frameworks.find((item: any) => item.id === draft.id); item.configuration = structuredClone(draft); item.enabled = true; item.setupRequired = false; }),
    onBackendFrameworkInstallProgress: mock(() => () => {}),
    installBackendFramework: mock(async (id: string) => { const entry = catalog.frameworks.find((entry: any) => entry.id === id);
      const configuration = { ...entry.configuration, executablePath: '/managed/python', projectPath: id === 'plugin:hermes' ? '/managed/hermes' : '' };
      entry.configuration = configuration; entry.setupRequired = false; entry.enabled = true;
      return { success: true, configuration, test: { success: true, checks: [] } }; }),
  };
  (window as any).electronAPI = api;
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await React.act(async () => root.render(React.createElement(BackendFrameworkSettings, { workspaceId: 'workspace', onChanged: () => {} })));
  await flush();
});
afterEach(async () => { await React.act(async () => root.unmount()); document.body.innerHTML = ''; });
afterAll(async () => { await dom.happyDOM.close(); });

test('shows five collapsed frameworks in Chinese with no translation keys or code editors', () => {
  expect(body()).toContain('后端框架');
  expect(document.querySelectorAll('[data-framework]')).toHaveLength(5);
  expect(row('codex').textContent).toContain('尚未配置');
  expect(document.querySelectorAll('[aria-expanded="false"]')).toHaveLength(5);
  expect(document.querySelectorAll('textarea')).toHaveLength(0);
  expect(document.querySelectorAll('input:not([type="file"])')).toHaveLength(0);
  expect(body()).not.toContain('settings.ai.');
});

test('expansion exposes only supported implementations and readable configuration labels', async () => {
  await click(row('plugin:dsh').querySelector('button')!);
  expect(body()).toContain('后端位置'); expect(body()).toContain('功能实现方式');
  expect(field('DeepSeek Harness 会话恢复').value).toBe('host');
  expect((field('DeepSeek Harness 执行中追加指令') as HTMLSelectElement).disabled).toBe(true);
  expect(field('DeepSeek Harness 文件与命令').value).toBe('native');
  await click(row('codex').querySelector('button')!);
  expect((field('Codex 文件与命令') as HTMLSelectElement).options).toHaveLength(1);
  expect(body()).not.toContain('settings.ai.');
});

test('one-click installation uses the chosen download source, fills verified locations and preserves unsaved feature choices', async () => {
  await click(row('plugin:hermes').querySelector('button')!);
  await change(field('Hermes 下载源'), 'mirror');
  await change(field('Hermes 浏览器操作'), 'disabled');
  await click(button('plugin:hermes', '一键下载安装'));
  expect(api.installBackendFramework.mock.calls[0]).toEqual(['plugin:hermes', 'mirror']);
  expect(field('Hermes 运行程序位置').value).toBe('/managed/python');
  expect(field('Hermes 浏览器操作').value).toBe('disabled');
  expect(body()).toContain('安装并测试成功');
  expect(body()).not.toContain('settings.ai.');
});

test('failed installation leaves the user draft available for retry', async () => {
  api.installBackendFramework.mockImplementationOnce(async () => ({ success: false, error: '下载连接失败' }));
  await click(row('plugin:dsh').querySelector('button')!);
  await change(field('DeepSeek Harness 运行程序位置'), '/existing/python');
  await click(button('plugin:dsh', '一键下载安装'));
  expect(field('DeepSeek Harness 运行程序位置').value).toBe('/existing/python');
  expect(body()).toContain('下载连接失败');
});

test('validity test uses the unsaved location and invalidates its result when the location changes', async () => {
  await click(row('plugin:dsh').querySelector('button')!);
  await change(field('DeepSeek Harness 运行程序位置'), '/opt/agents/python');
  await click(button('plugin:dsh', '测试有效性'));
  expect(api.testBackendFramework.mock.calls[0][0].executablePath).toBe('/opt/agents/python');
  expect(api.saveBackendFramework).not.toHaveBeenCalled();
  expect(row('plugin:dsh').textContent).toContain('本地框架测试通过');
  await change(field('DeepSeek Harness 运行程序位置'), '/another/python');
  expect(row('plugin:dsh').textContent).not.toContain('本地框架测试通过');
});

test('saves location and feature choices, keeps feedback visible, and preserves failed drafts for retry', async () => {
  await click(row('plugin:dsh').querySelector('button')!);
  await change(field('DeepSeek Harness 运行程序位置'), '/opt/python');
  await change(field('DeepSeek Harness 浏览器操作'), 'disabled');
  api.saveBackendFramework.mockImplementationOnce(async () => { throw new Error('位置无法使用'); });
  await click(button('plugin:dsh', '保存配置'));
  expect(row('plugin:dsh').textContent).toContain('位置无法使用');
  expect(field('DeepSeek Harness 运行程序位置').value).toBe('/opt/python');
  await click(button('plugin:dsh', '保存配置'));
  expect(catalog.frameworks.find((item: any) => item.id === 'plugin:dsh').configuration.features.browser).toBe('disabled');
  expect(row('plugin:dsh').textContent).toContain('配置已保存');
  expect(body()).not.toContain('settings.ai.');
});

test('server catalog updates preserve configuration edits that have not been saved', async () => {
  await click(row('plugin:dsh').querySelector('button')!);
  await change(field('DeepSeek Harness 运行程序位置'), '/unsaved/python');
  catalog.frameworks.find((item: any) => item.id === 'plugin:dsh').configuration.executablePath = '/server/python';
  await React.act(async () => notifyChanged()); await flush();
  expect(field('DeepSeek Harness 运行程序位置').value).toBe('/unsaved/python');
  expect(row('plugin:dsh').textContent).toContain('有未保存修改');
});
