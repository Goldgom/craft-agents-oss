import i18n from 'i18next';
import { CLIENT_FILE_MAX_BYTES, CLIENT_FILE_MAX_COUNT, CLIENT_FILE_TIMEOUT_MS, validateClientFileRequest, type ClientFileRequest, type ClientFileSelection } from '@craft-agent/core/types';
import { blobBase64 } from './browser-files';

let pending = false;

/** The visible button provides the user gesture required by browser file pickers. */
export async function requestBrowserClientFiles(input: ClientFileRequest): Promise<ClientFileSelection> {
  const request = validateClientFileRequest(input);
  if (pending) throw new Error('A file request is already waiting for your response');
  pending = true;
  try {
    return await new Promise<ClientFileSelection>((resolve, reject) => {
      const dialog = document.createElement('dialog');
      dialog.style.cssText = 'max-width:440px;width:calc(100% - 32px);padding:24px;border:1px solid #888;border-radius:12px;background:Canvas;color:CanvasText;z-index:2147483647';
      const title = document.createElement('h2');
      title.textContent = i18n.t('remoteFiles.title');
      const reason = document.createElement('p');
      reason.textContent = request.reason;
      const detail = document.createElement('p');
      detail.textContent = i18n.t('remoteFiles.detail');
      const choose = document.createElement('button');
      choose.textContent = i18n.t('remoteFiles.choose');
      const cancel = document.createElement('button');
      cancel.textContent = i18n.t('remoteFiles.cancel');
      for (const button of [choose, cancel]) button.style.cssText = 'padding:8px 16px;margin:8px 8px 0 0;cursor:pointer';
      const picker = document.createElement('input');
      picker.type = 'file'; picker.multiple = request.allowMultiple ?? true; picker.hidden = true;
      picker.accept = request.extensions?.map(ext => `.${ext}`).join(',') ?? '';
      let settled = false;
      const finish = (result?: ClientFileSelection, error?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); dialog.remove();
        window.removeEventListener('craft-agent:file-picker-cancel', onNativeCancel);
        if (error) reject(error); else resolve(result ?? { canceled: true, files: [] });
      };
      const onNativeCancel = () => finish();
      window.addEventListener('craft-agent:file-picker-cancel', onNativeCancel);
      const timer = setTimeout(() => finish(), CLIENT_FILE_TIMEOUT_MS - 5000);
      cancel.onclick = () => finish();
      dialog.oncancel = (event) => { event.preventDefault(); finish(); };
      picker.oncancel = () => finish();
      choose.onclick = () => picker.click();
      picker.onchange = async () => {
        const files = Array.from(picker.files ?? []);
        if (!files.length) { finish(); return; }
        if (files.length > CLIENT_FILE_MAX_COUNT || files.reduce((size, file) => size + file.size, 0) > CLIENT_FILE_MAX_BYTES) {
          detail.textContent = i18n.t('remoteFiles.limit'); return;
        }
        choose.disabled = true;
        try {
          const result = await Promise.all(files.map(async file => ({ name: file.name, mimeType: file.type, base64: await blobBase64(file) })));
          finish({ canceled: false, files: result });
        } catch (error) { finish(undefined, error); }
      };
      dialog.append(title, reason, detail, choose, cancel, picker);
      document.body.append(dialog);
      dialog.showModal();
    });
  } finally { pending = false; }
}
