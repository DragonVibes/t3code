# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. Supported iOS devices transcribe locally. Other clients upload the
recording to the environment, whose
[`VoiceTranscription`](../../apps/server/src/voiceTranscription/VoiceTranscription.ts)
service picks the provider.

Apple on-device transcription runs on the environment host, not on the client.
A browser cannot reach SpeechAnalyzer, and a remote web or mobile client
connected to a Mac should get the same provider the desktop app gets. The server
spawns [`t3-apple-speech`](../../native/apple-speech/main.swift) through
[`AppleSpeechHelper`](../../apps/server/src/voiceTranscription/AppleSpeechHelper.ts),
which probes the helper once per process and advertises
`capabilities.appleOnDeviceTranscription` only on macOS 26 or later with a
working helper. That capability is the client's signal to offer the provider.
The server also refuses to mint an upload URL for it when the capability is
absent, so a client that skips the check, or settings copied to a Linux host,
fail with a clear message instead of a missing binary.

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
