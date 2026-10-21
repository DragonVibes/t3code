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
]);
export type VoiceTranscriptionFailureCode = typeof VoiceTranscriptionFailureCode.Type;

/** Non-2xx body of `POST <relativeUrl>`. */
export const VoiceTranscriptionFailure = Schema.Struct({
  code: VoiceTranscriptionFailureCode,
  message: Schema.String,
});
export type VoiceTranscriptionFailure = typeof VoiceTranscriptionFailure.Type;

export class VoiceTranscriptionNotConfiguredError extends Schema.TaggedError<VoiceTranscriptionNotConfiguredError>()(
  "VoiceTranscriptionNotConfiguredError",
  {
    message: Schema.String,
  },
) {}

export class VoiceTranscriptionSigningKeyError extends Schema.TaggedError<VoiceTranscriptionSigningKeyError>()(
  "VoiceTranscriptionSigningKeyError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to load the voice transcription signing key.";
  }
}
