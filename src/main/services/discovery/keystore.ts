import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { UserError } from '../../ipc/dispatch';

/** The slice of Electron's `safeStorage` the key store needs; tests and e2e inject a stand-in. */
export interface SecretCrypto {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
  /** Linux only. `basic_text` means no keyring: Electron then "encrypts" with a hardcoded key. */
  getSelectedStorageBackend?(): string;
}

export interface Adzuna {
  appId: string;
  appKey: string;
}
const AdzunaKey = z.object({
  appId: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/, 'The application id looks wrong.'),
  appKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, 'The application key looks wrong.'),
});
export const AdzunaKeyInputSchema = AdzunaKey;

/**
 * API keys, encrypted with the OS keyring (`safeStorage`) into `<userData>/secrets/<id>.bin` (0600). Nothing is
 * ever returned to the renderer except "is it set": `get` is for the scan code in the main process only. A key
 * that cannot be decrypted (keyring locked or changed) reads as unset.
 */
export function createKeyStore(dir: string, crypto: SecretCrypto) {
  const file = (id: string): string => join(dir, `${id}.bin`);
  return {
    isSet: (id: 'adzuna'): boolean => existsSync(file(id)),
    set(id: 'adzuna', value: Adzuna): void {
      if (!crypto.isEncryptionAvailable())
        throw new UserError(
          'Secure storage is not available on this system (no keyring found), so the key was not saved.',
        );
      if (crypto.getSelectedStorageBackend?.() === 'basic_text')
        throw new UserError(
          'No system keyring was found (Stellio would only get weak, plain-text-grade storage), so the key was not saved. Start a keyring such as GNOME Keyring or KWallet, then try again.',
        );
      const parsed = AdzunaKey.safeParse(value);
      if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? 'Invalid key.');
      mkdirSync(dirname(file(id)), { recursive: true, mode: 0o700 });
      writeFileSync(file(id), crypto.encryptString(JSON.stringify(parsed.data)), { mode: 0o600 });
      chmodSync(file(id), 0o600);
    },
    get(id: 'adzuna'): Adzuna | null {
      try {
        return AdzunaKey.parse(JSON.parse(crypto.decryptString(readFileSync(file(id)))));
      } catch {
        return null;
      }
    },
    clear(id: 'adzuna'): void {
      rmSync(file(id), { force: true });
    },
  };
}
export type KeyStore = ReturnType<typeof createKeyStore>;
