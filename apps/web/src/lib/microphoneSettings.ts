import { isElectron } from "~/env";
import { isMacPlatform } from "~/lib/utils";
import { readLocalApi } from "~/localApi";

export const canOpenMicrophoneSystemSettings =
  isElectron && typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

export async function openMicrophoneSystemSettings(): Promise<void> {
  await readLocalApi()?.shell.openSystemSettings("microphone");
}
