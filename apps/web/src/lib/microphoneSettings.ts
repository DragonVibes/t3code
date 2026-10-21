import { SystemSettingsPaneSchema } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isElectron } from "~/env";
import { isMacPlatform } from "~/lib/utils";
import { readLocalApi } from "~/localApi";

// None until SystemSettingsPaneSchema lists "microphone"; the desktop side already handles it.
const microphonePane = Schema.decodeUnknownOption(SystemSettingsPaneSchema)("microphone");

export const canOpenMicrophoneSystemSettings =
  isElectron &&
  typeof navigator !== "undefined" &&
  isMacPlatform(navigator.platform) &&
  Option.isSome(microphonePane);

export async function openMicrophoneSystemSettings(): Promise<void> {
  if (Option.isNone(microphonePane)) return;
  await readLocalApi()?.shell.openSystemSettings(microphonePane.value);
}
