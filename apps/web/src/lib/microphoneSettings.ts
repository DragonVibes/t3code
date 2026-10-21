import { isElectron } from "~/env";
import { isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { readLocalApi } from "~/localApi";

/** Where a user unblocks the microphone. Electron grants page requests itself, so only the OS can refuse. */
export type MicrophonePermissionHost = "browser" | "macos" | "windows" | "linux";

function detectMicrophonePermissionHost(): MicrophonePermissionHost {
  if (!isElectron || typeof navigator === "undefined") return "browser";
  if (isMacPlatform(navigator.platform)) return "macos";
  return isWindowsPlatform(navigator.platform) ? "windows" : "linux";
}

export const microphonePermissionHost = detectMicrophonePermissionHost();

export async function openMicrophoneSystemSettings(): Promise<void> {
  await readLocalApi()?.shell.openSystemSettings("microphone");
}
