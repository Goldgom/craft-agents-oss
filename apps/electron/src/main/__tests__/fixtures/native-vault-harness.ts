import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ElectronCredentialVault, type SafeStorageAdapter } from '../../credential-vault';

/** Fake OS key store: dummy-only authenticated encryption, never Electron/user keys. */
export function nativeVaultFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'tokenbird-native-vault-'));
  const filePath = join(directory, 'credentials.enc');
  const osKey = randomBytes(32);
  const state = { available: true, selected: 'gnome_libsecret', failEncrypt: false, failDecrypt: false, wraps: 0, unwraps: 0 };
  const safeStorage: SafeStorageAdapter = {
    isEncryptionAvailable: () => state.available,
    getSelectedStorageBackend: () => state.selected,
    encryptString(value) {
      state.wraps++;
      if (state.failEncrypt) throw new Error('dummy-secret-echo');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', osKey, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value) {
      state.unwraps++;
      if (state.failDecrypt) throw new Error('dummy-secret-echo');
      const cipher = createDecipheriv('aes-256-gcm', osKey, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
  const create = () => new ElectronCredentialVault({ safeStorage, platform: 'linux', filePath });
  return { directory, filePath, safeStorage, state, create, cleanup: () => { osKey.fill(0); rmSync(directory, { recursive: true, force: true }); } };
}
