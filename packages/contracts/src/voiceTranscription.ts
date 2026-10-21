import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** OpenAI, Groq, and whisper.cpp all reject uploads above 25 MB. */
export const VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const VOICE_TRANSCRIPTION_URL_TTL_MS = 2 * 60_000;

/** Container types without codec parameters; clients strip `;codecs=...` before minting. */
export const VoiceTranscriptionAudioMimeType = Schema.Literals([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
]);
export type VoiceTranscriptionAudioMimeType = typeof VoiceTranscriptionAudioMimeType.Type;

export const VoiceTranscriptionCreateUrlInput = Schema.Struct({
  mimeType: VoiceTranscriptionAudioMimeType,
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES),
  ),
});
export type VoiceTranscriptionCreateUrlInput = typeof VoiceTranscriptionCreateUrlInput.Type;

export const VoiceTranscriptionCreateUrlResult = Schema.Struct({
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: Schema.Number,
});
export type VoiceTranscriptionCreateUrlResult = typeof VoiceTranscriptionCreateUrlResult.Type;

/** 200 body of `POST <relativeUrl>`. */
export const VoiceTranscriptionResult = Schema.Struct({
  text: Schema.String,
});
export type VoiceTranscriptionResult = typeof VoiceTranscriptionResult.Type;

export const VoiceTranscriptionFailureCode = Schema.Literals([
  "not_configured",
  "invalid_upload",
  "upstream_rejected_credentials",
  "upstream_failed",
  "internal",
]);
export type VoiceTranscriptionFailureCode = typeof VoiceTranscriptionFailureCode.Type;

/** Non-2xx body of `POST <relativeUrl>`. */
export const VoiceTranscriptionFailure = Schema.Struct({
  code: VoiceTranscriptionFailureCode,
  message: Schema.String,
});
export type VoiceTranscriptionFailure = typeof VoiceTranscriptionFailure.Type;

export const VoiceTranscriptionNotConfiguredReason = Schema.Literals([
  "disabled",
  "missing-base-url",
  "missing-model",
  "missing-api-key",
  "invalid-base-url",
  "insecure-base-url",
  "apple-unsupported-host",
  "apple-unavailable",
  "unsupported-format",
  "unsupported-locale",
]);
export type VoiceTranscriptionNotConfiguredReason =
  typeof VoiceTranscriptionNotConfiguredReason.Type;

export class VoiceTranscriptionNotConfiguredError extends Schema.TaggedError<VoiceTranscriptionNotConfiguredError>()(
  "VoiceTranscriptionNotConfiguredError",
  {
    reason: VoiceTranscriptionNotConfiguredReason,
    providerName: Schema.String,
    mimeType: Schema.optional(VoiceTranscriptionAudioMimeType),
    locale: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "disabled":
        return "Voice transcription is turned off for this environment.";
      case "missing-base-url":
        return "Voice transcription needs an endpoint URL.";
      case "missing-model":
        return "Voice transcription needs a model name.";
      case "missing-api-key":
        return `Add an ${this.providerName} API key to use voice transcription.`;
      case "invalid-base-url":
        return "The voice transcription endpoint URL is not valid.";
      case "insecure-base-url":
        return "Voice transcription sends an API key only over https, unless the endpoint is on this machine or a private network.";
      case "apple-unsupported-host":
        return "Apple on-device transcription needs macOS 26 or later on the machine running T3 Code.";
      case "apple-unavailable":
        return "Apple on-device transcription is unavailable on the machine running T3 Code.";
      case "unsupported-format":
        return this.mimeType
          ? `${this.providerName} does not accept ${this.mimeType} recordings.`
          : `${this.providerName} does not accept this recording format.`;
      case "unsupported-locale":
        return this.locale
          ? `${this.providerName} does not support the language '${this.locale}'.`
          : `${this.providerName} does not support this Mac's system language.`;
    }
  }
}

export class VoiceTranscriptionInternalError extends Schema.TaggedError<VoiceTranscriptionInternalError>()(
  "VoiceTranscriptionInternalError",
  {
    stage: Schema.Literals(["read-settings", "load-signing-key"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Voice transcription hit a server error.";
  }
}
