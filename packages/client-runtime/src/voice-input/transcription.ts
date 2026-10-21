/**
 * Cancellation is cooperative. Work that holds a resource the controller owns, such as a
 * native speech session or the recording file, settles only after that work has stopped.
 * Work that holds nothing of the controller's, such as a URL mint or an in-memory decode,
 * may settle as cancelled while it finishes in the background.
 */
export type VoiceTranscriptionOptions = {
  readonly signal: AbortSignal;
};

export type PreparedVoiceTranscription = {
  readonly locale: string;
  readonly transcribe: (uri: string, options: VoiceTranscriptionOptions) => Promise<string>;
};

export type VoiceTranscriber = {
  readonly prepare: (options: VoiceTranscriptionOptions) => Promise<PreparedVoiceTranscription>;
};

export type VoiceTranscriptionErrorCode =
  | "unavailable"
  | "unsupported-locale"
  | "preparation-failed"
  | "transcription-failed"
  | "cancelled";

/** `message` is shown to the user as written, so phrase it for them. */
export class VoiceTranscriptionError extends Error {
  readonly code: VoiceTranscriptionErrorCode;
  /** Sending the same recording again may succeed, as after a network or provider failure. */
  readonly retryable: boolean;

  constructor(
    code: VoiceTranscriptionErrorCode,
    message: string,
    options?: ErrorOptions & { readonly retryable?: boolean },
  ) {
    super(message, options);
    this.name = "VoiceTranscriptionError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

export function throwIfVoiceTranscriptionAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.");
  }
}
