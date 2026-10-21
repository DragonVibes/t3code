# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. Supported iOS devices transcribe locally. Web and desktop upload the
recording to the environment, which forwards it to the configured speech-to-text
API, because the API key is an environment secret and never reaches a client.
The client asks `voice.createTranscriptionUrl` for a short-lived capability URL
and posts the audio there, so the upload works over every connection mode without
a separate credential. Browsers record whatever container their engine supports,
and the [web transcriber](../../apps/web/src/lib/voiceWav.ts) re-encodes every
recording to 16 kHz mono WAV before upload, since xAI rejects WebM and a local
whisper.cpp server would otherwise need ffmpeg.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.
