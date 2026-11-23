import { RPC_CHANNELS } from './channels'

/** Allow five minutes for the user to finish choosing a file or folder. */
export const FILE_DIALOG_TIMEOUT_MS = 5 * 60_000

export function isFileDialogChannel(channel: string): boolean {
  return channel === 'client:openFileDialog'
    || channel === RPC_CHANNELS.file.OPEN_DIALOG
    || channel === RPC_CHANNELS.dialog.OPEN_FOLDER
    || channel === RPC_CHANNELS.gitbash.BROWSE
    || channel === RPC_CHANNELS.resources.IMPORT_FROM_FILE
    || channel === RPC_CHANNELS.settings.IMPORT_ALL_DATA
}
