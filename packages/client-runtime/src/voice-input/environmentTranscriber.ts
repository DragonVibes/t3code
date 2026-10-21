import {
  VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES,
  VOICE_TRANSCRIPTION_PROVIDER_DEFAULTS,
  VoiceTranscriptionAudioMimeType,
  VoiceTranscriptionFailure,
  VoiceTranscriptionNotConfiguredError,
  VoiceTranscriptionResult,
  type VoiceTranscriptionCreateUrlInput,
  type VoiceTranscriptionCreateUrlResult,
  type VoiceTranscriptionNotConfiguredReason,
  type VoiceTranscriptionProvider,
  type VoiceTranscriptionSettings,
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
  /**
   * The environment's settings, null while unknown, in which case the server decides.
   * `apiKey` arrives redacted; only its presence is meaningful.
   */
  readonly readSettings: () => VoiceTranscriptionSettings | null;
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
const decodeNotConfigured = Schema.decodeUnknownOption(VoiceTranscriptionNotConfiguredError);

/** The server's names, which its not-configured messages quote. */
const PROVIDER_NAMES: Record<VoiceTranscriptionProvider, string> = {
  "openai-compatible": "OpenAI",
  xai: "xAI",
  "apple-on-device": "Apple on-device transcription",
};

/**
 * The checks the server runs before minting an upload URL that the client can
 * repeat from settings it already holds, so a misconfigured environment fails
 * before recording starts instead of after the upload.
 */
export function voiceTranscriptionUnavailableReason(
  settings: VoiceTranscriptionSettings,
): VoiceTranscriptionNotConfiguredReason | null {
  if (!settings.enabled) return "disabled";
  // The client's capability may predate the Apple probe's first answer, which the mint waits for.
  if (settings.provider === "apple-on-device") return null;
  const hostedBaseUrl = VOICE_TRANSCRIPTION_PROVIDER_DEFAULTS[settings.provider].baseUrl;
  if (!settings.apiKey && settings.baseUrl.replace(/\/+$/, "") === hostedBaseUrl) {
    return "missing-api-key";
  }
  return null;
}

function containerMimeType(blobType: string): VoiceTranscriptionAudioMimeType | null {
  return Option.getOrNull(decodeMimeType(blobType.split(";")[0]?.trim().toLowerCase()));
}

/** `message` is a getter on the class, so the error is decoded before it is read. */
function notConfiguredMessage(error: unknown): string | null {
  const decoded = Option.getOrNull(decodeNotConfigured(error));
  if (decoded) return decoded.message;
  const tagged =
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "VoiceTranscriptionNotConfiguredError";
  return tagged ? "Voice input is not configured on this environment." : null;
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
      const settings = dependencies.readSettings();
      const reason = settings && voiceTranscriptionUnavailableReason(settings);
      if (reason) {
        const refusal = new VoiceTranscriptionNotConfiguredError({
          reason,
          providerName: PROVIDER_NAMES[settings.provider],
        });
        throw new VoiceTranscriptionError("unavailable", refusal.message, { cause: refusal });
      }
      const language = dependencies.language().trim();
      return {
        locale: language.length > 0 ? language : dependencies.fallbackLocale(),
        transcribe,
      };
    },
  };
}
