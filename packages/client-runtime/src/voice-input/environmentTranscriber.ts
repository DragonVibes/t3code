import {
  VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES,
  VoiceTranscriptionAudioMimeType,
  VoiceTranscriptionFailure,
  VoiceTranscriptionResult,
  type VoiceTranscriptionCreateUrlInput,
  type VoiceTranscriptionCreateUrlResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "./transcription.ts";

export type EnvironmentVoiceTranscriberDependencies = {
  /** Configured ISO-639-1 code. Empty lets the model detect the language. */
  readonly language: () => string;
  /** Locale used for transcript spacing when no language is configured. */
  readonly fallbackLocale: () => string;
  /** Rejects with the RPC's tagged error when the environment refuses to mint a URL. */
  readonly createTranscriptionUrl: (
    input: VoiceTranscriptionCreateUrlInput,
  ) => Promise<VoiceTranscriptionCreateUrlResult>;
  /** Null when the environment has no reachable HTTP base, such as while disconnected. */
  readonly resolveUrl: (relativeUrl: string) => string | null;
  readonly fetch: typeof globalThis.fetch;
  /** Re-encodes the recording before upload, such as to the WAV every provider accepts. */
  readonly prepareAudio?: (recording: Blob) => Promise<Blob>;
};

const decodeMimeType = Schema.decodeUnknownOption(VoiceTranscriptionAudioMimeType);
const decodeResult = Schema.decodeUnknownOption(VoiceTranscriptionResult);
const decodeFailure = Schema.decodeUnknownOption(VoiceTranscriptionFailure);

function containerMimeType(blobType: string): VoiceTranscriptionAudioMimeType | null {
  return Option.getOrNull(decodeMimeType(blobType.split(";")[0]?.trim().toLowerCase()));
}

function isNotConfiguredError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "VoiceTranscriptionNotConfiguredError"
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function failureFromResponse(status: number, body: unknown): VoiceTranscriptionError {
  const failure = Option.getOrNull(decodeFailure(body));
  if (!failure) {
    return new VoiceTranscriptionError(
      "transcription-failed",
      `The environment could not transcribe the recording (HTTP ${status}).`,
    );
  }
  return new VoiceTranscriptionError(
    failure.code === "not_configured" ? "unavailable" : "transcription-failed",
    failure.message,
  );
}

/**
 * Uploads the recording to the environment, which forwards it to the configured
 * speech-to-text API. The API key never leaves the environment, so the client only
 * needs the capability URL the environment mints per recording.
 */
export function createEnvironmentVoiceTranscriber(
  dependencies: EnvironmentVoiceTranscriberDependencies,
): VoiceTranscriber {
  const transcribe = async (uri: string, { signal }: { readonly signal: AbortSignal }) => {
    throwIfVoiceTranscriptionAborted(signal);
    let blob: Blob;
    try {
      blob = await (await dependencies.fetch(uri)).blob();
    } catch (error) {
      throw new VoiceTranscriptionError(
        "transcription-failed",
        "The recording is no longer available.",
        { cause: error },
      );
    }
    throwIfVoiceTranscriptionAborted(signal);
    if (dependencies.prepareAudio && blob.size > 0) {
      try {
        blob = await dependencies.prepareAudio(blob);
      } catch (error) {
        throw new VoiceTranscriptionError(
          "transcription-failed",
          "Could not convert the recording for upload.",
          { cause: error },
        );
      }
      throwIfVoiceTranscriptionAborted(signal);
    }

    const mimeType = containerMimeType(blob.type);
    if (!mimeType) {
      throw new VoiceTranscriptionError(
        "transcription-failed",
        "This browser's recording format is not supported.",
      );
    }
    if (blob.size === 0) {
      throw new VoiceTranscriptionError("transcription-failed", "No audio was recorded.");
    }
    if (blob.size > VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
      throw new VoiceTranscriptionError(
        "transcription-failed",
        "The recording is too large to transcribe.",
      );
    }

    let minted: VoiceTranscriptionCreateUrlResult;
    try {
      minted = await dependencies.createTranscriptionUrl({ mimeType, sizeBytes: blob.size });
    } catch (error) {
      if (isNotConfiguredError(error)) {
        throw new VoiceTranscriptionError(
          "unavailable",
          "Voice input is not configured on this environment.",
          { cause: error },
        );
      }
      throw new VoiceTranscriptionError(
        "transcription-failed",
        "Could not reach the environment to transcribe the recording.",
        { cause: error },
      );
    }
    throwIfVoiceTranscriptionAborted(signal);

    const url = dependencies.resolveUrl(minted.relativeUrl);
    if (url === null) {
      throw new VoiceTranscriptionError(
        "transcription-failed",
        "The environment is not connected.",
      );
    }

    let response: Response;
    try {
      response = await dependencies.fetch(url, {
        method: "POST",
        headers: { "content-type": mimeType },
        body: blob,
        signal,
      });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        throw new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.", {
          cause: error,
        });
      }
      throw new VoiceTranscriptionError(
        "transcription-failed",
        "Could not reach the environment to transcribe the recording.",
        { cause: error },
      );
    }

    const body = await readJson(response);
    if (!response.ok) {
      throw failureFromResponse(response.status, body);
    }
    const result = Option.getOrNull(decodeResult(body));
    if (!result) {
      throw new VoiceTranscriptionError(
        "transcription-failed",
        "The environment returned an unexpected transcription response.",
      );
    }
    return result.text;
  };

  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      const language = dependencies.language().trim();
      return {
        locale: language.length > 0 ? language : dependencies.fallbackLocale(),
        transcribe,
      };
    },
  };
}
