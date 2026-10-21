import {
  VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES,
  VOICE_TRANSCRIPTION_PROVIDER_DEFAULTS,
  VoiceTranscriptionAudioMimeType,
  VoiceTranscriptionFailure,
  VoiceTranscriptionResult,
  type HttpVoiceTranscriptionProvider,
  type VoiceTranscriptionCreateUrlInput,
  type VoiceTranscriptionCreateUrlResult,
  type VoiceTranscriptionSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "./transcription.ts";

/** What the environment already told the client about its transcription setup. */
export type VoiceTranscriptionConfiguration = {
  /** `apiKey` arrives redacted; only its presence is meaningful. */
  readonly settings: VoiceTranscriptionSettings;
  readonly appleOnDeviceTranscription: boolean;
};

export type EnvironmentVoiceTranscriberDependencies = {
  /** Configured ISO-639-1 code. Empty lets the model detect the language. */
  readonly language: () => string;
  /** Locale used for transcript spacing when no language is configured. */
  readonly fallbackLocale: () => string;
  /** Null while the environment's config is unknown, in which case the server decides. */
  readonly readConfiguration: () => VoiceTranscriptionConfiguration | null;
  /** Rejects with the RPC's tagged error when the environment refuses to mint a URL. */
  readonly createTranscriptionUrl: (
    input: VoiceTranscriptionCreateUrlInput,
  ) => Promise<VoiceTranscriptionCreateUrlResult>;
  /** Null when the environment has no reachable HTTP base, such as while disconnected. */
  readonly resolveUrl: (relativeUrl: string) => string | null;
  readonly fetch: typeof globalThis.fetch;
  readonly prepareAudio?: (recording: Blob) => Promise<Blob>;
};

const decodeMimeType = Schema.decodeUnknownOption(VoiceTranscriptionAudioMimeType);
const decodeResult = Schema.decodeUnknownOption(VoiceTranscriptionResult);
const decodeFailure = Schema.decodeUnknownOption(VoiceTranscriptionFailure);

const HOSTED_PROVIDER_NAMES: Record<HttpVoiceTranscriptionProvider, string> = {
  "openai-compatible": "OpenAI",
  xai: "xAI",
};

/**
 * The checks the server runs before minting an upload URL, so a misconfigured
 * environment fails before the microphone opens. Messages match the server's.
 */
export function voiceTranscriptionUnavailableReason({
  settings,
  appleOnDeviceTranscription,
}: VoiceTranscriptionConfiguration): string | null {
  if (!settings.enabled) return "Voice transcription is turned off for this environment.";
  if (settings.provider === "apple-on-device") {
    return appleOnDeviceTranscription
      ? null
      : "Apple on-device transcription needs macOS 26 or later on the machine running T3 Code.";
  }
  const hostedBaseUrl = VOICE_TRANSCRIPTION_PROVIDER_DEFAULTS[settings.provider].baseUrl;
  if (!settings.apiKey && settings.baseUrl.replace(/\/+$/, "") === hostedBaseUrl) {
    return `Add an ${HOSTED_PROVIDER_NAMES[settings.provider]} API key to use voice transcription.`;
  }
  return null;
}

function containerMimeType(blobType: string): VoiceTranscriptionAudioMimeType | null {
  return Option.getOrNull(decodeMimeType(blobType.split(";")[0]?.trim().toLowerCase()));
}

function notConfiguredMessage(error: unknown): string | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("_tag" in error) ||
    error._tag !== "VoiceTranscriptionNotConfiguredError"
  ) {
    return null;
  }
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return message.length > 0 ? message : "Voice input is not configured on this environment.";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function cancelledError(): VoiceTranscriptionError {
  return new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.");
}

function settleOnAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
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
        blob = await settleOnAbort(dependencies.prepareAudio(blob), signal);
      } catch (error) {
        if (error instanceof VoiceTranscriptionError) throw error;
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
      minted = await settleOnAbort(
        dependencies.createTranscriptionUrl({ mimeType, sizeBytes: blob.size }),
        signal,
      );
    } catch (error) {
      if (error instanceof VoiceTranscriptionError) throw error;
      const notConfigured = notConfiguredMessage(error);
      if (notConfigured !== null) {
        throw new VoiceTranscriptionError("unavailable", notConfigured, { cause: error });
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
      const configuration = dependencies.readConfiguration();
      const unavailable = configuration && voiceTranscriptionUnavailableReason(configuration);
      if (unavailable) throw new VoiceTranscriptionError("unavailable", unavailable);
      const language = dependencies.language().trim();
      return {
        locale: language.length > 0 ? language : dependencies.fallbackLocale(),
        transcribe,
      };
    },
  };
}
