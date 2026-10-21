# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. Supported iOS devices transcribe locally, and Android has no voice input.
Web and desktop upload the recording to the environment, whose
[`VoiceTranscription`](../../apps/server/src/voiceTranscription/VoiceTranscription.ts)
service sends it to the configured provider, because an API key is an environment
secret and never reaches a client. The client asks `voice.createTranscriptionUrl`
for a short-lived capability URL and posts the audio there, so the upload works
over every connection mode without a separate credential. Browsers record whatever
container their engine supports, and the [web transcriber](../../apps/web/src/lib/voiceWav.ts)
re-encodes every recording to 16 kHz mono WAV before upload, for the reasons given
with that code.

Apple on-device transcription runs on the environment host, not on the client.
A browser cannot reach SpeechAnalyzer, and a remote web client connected to a
Mac gets the same provider the desktop app gets. The server spawns
[`t3-apple-speech`](../../native/apple-speech/main.swift) through
[`AppleSpeechHelper`](../../apps/server/src/voiceTranscription/AppleSpeechHelper.ts),
which probes the helper in the background at startup, retries a probe that times
out, and advertises `capabilities.appleOnDeviceTranscription` only on macOS 26 or
later once a probe has found a working helper. The descriptor never waits for the
probe, and a client can subscribe before it answers, as the desktop app does at
launch. An answer that changes the capability therefore re-sends the server config
snapshot to every subscriber. That capability is the client's signal to offer
the provider. The server also refuses to mint an upload URL for it when the
capability is absent, so a client that skips the check, or settings copied to a
Linux host, fail with a clear message instead of a missing binary. Only the
desktop app bundles the helper, so `npx t3` on a Mac does not offer the provider.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. The
[web transcriber](../../packages/client-runtime/src/voice-input/environmentTranscriber.ts)
also repeats the server's configuration checks during preparation from the settings
and capabilities the client already holds, so a misconfigured environment fails with
the server's wording before the microphone opens. Draft ownership, text, and
revision are captured before recording and checked before insertion, so a late
transcript cannot overwrite a draft that was edited or replaced; a draft that
refuses the text, such as a choice-only agent question, counts as changed. A
transcription that fails after the recording succeeded keeps the audio behind the
`retry-transcription` error action until the user retries, dismisses, or starts
over, so a failed upload does not cost the recording.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires work that holds a resource the controller owns to settle only
after it has stopped; the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts)
checks cancellation between native calls and discards late results. Work that
holds nothing of the controller's, such as the web transcriber's URL mint or WAV
decode, may settle as cancelled while it finishes in the background, so a stuck
RPC cannot block the next recording.
