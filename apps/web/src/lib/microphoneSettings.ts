import { SystemSettingsPaneSchema } from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isElectron } from "~/env";
import { readLocalApi } from "~/localApi";

// The desktop bridge accepts only the panes its contract lists. Decoding keeps this
// button off until "microphone" joins SystemSettingsPaneSchema, without a cast.
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
