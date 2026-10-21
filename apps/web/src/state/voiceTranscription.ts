import { AuthOrchestrationOperateScope, WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  createEnvironmentVoiceTranscriber,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

import { connectionAtomRuntime } from "../connection/runtime";
import { convertRecordingToWav } from "../lib/voiceWav";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readEnvironmentScope, readPreparedConnection } from "./session";

export const voiceTranscriptionEnvironment = {
  createTranscriptionUrl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:voice:create-transcription-url",
    tag: WS_METHODS.voiceCreateTranscriptionUrl,
  }),
};

export function createWebVoiceTranscriber(
  environmentId: EnvironmentId,
  language: () => string,
): VoiceTranscriber {
  return createEnvironmentVoiceTranscriber({
    language,
    fallbackLocale: () => navigator.language || "en-US",
    createTranscriptionUrl: async (input) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        voiceTranscriptionEnvironment.createTranscriptionUrl,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      return result.value;
    },
    resolveUrl: (relativeUrl) => {
      if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return null;
      const connection = readPreparedConnection(environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    fetch: (input, init) => fetch(input, init),
    prepareAudio: convertRecordingToWav,
  });
}
