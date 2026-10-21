import {
  VOICE_TRANSCRIPTION_PROVIDER_DEFAULTS,
  type HttpVoiceTranscriptionProvider,
  type VoiceTranscriptionProvider,
  type VoiceTranscriptionSettings,
} from "@t3tools/contracts";

export type VoiceInputPresetId =
  | "apple-on-device"
  | "local-whisper-cpp"
  | "openai-gpt-transcribe"
  | "openai-gpt-4o-mini-transcribe"
  | "openai-whisper-1"
  | "groq-whisper-large-v3-turbo"
  | "xai-grok-voice-transcribe"
  | "custom";

export type VoiceInputProviderTarget = Pick<
  VoiceTranscriptionSettings,
  "provider" | "baseUrl" | "model"
>;

export type VoiceInputTargetPatch = Partial<VoiceInputProviderTarget> &
  Pick<VoiceInputProviderTarget, "provider"> & { readonly apiKey?: "" };

export interface VoiceInputPreset {
  readonly id: Exclude<VoiceInputPresetId, "custom">;
  readonly label: string;
  readonly provider: VoiceTranscriptionProvider;
  readonly endpoint?: Pick<VoiceInputProviderTarget, "baseUrl" | "model">;
}

export const VOICE_INPUT_PROVIDER_LABELS: Record<VoiceTranscriptionProvider, string> = {
  "apple-on-device": "Apple on-device (free, private, runs on this Mac)",
  "openai-compatible": "OpenAI-compatible (OpenAI, Groq, local whisper.cpp)",
  xai: "xAI Grok",
};

const OPENAI = VOICE_TRANSCRIPTION_PROVIDER_DEFAULTS["openai-compatible"].baseUrl;

export const VOICE_INPUT_PRESETS: ReadonlyArray<VoiceInputPreset> = [
  {
    id: "apple-on-device",
    label: VOICE_INPUT_PROVIDER_LABELS["apple-on-device"],
    provider: "apple-on-device",
  },
  {
    id: "local-whisper-cpp",
    label: "Local whisper.cpp (free, no API key)",
    provider: "openai-compatible",
    endpoint: { baseUrl: "http://127.0.0.1:8080/v1", model: "whisper-1" },
  },
  {
    id: "openai-gpt-transcribe",
    label: "OpenAI gpt-transcribe (recommended)",
    provider: "openai-compatible",
    endpoint: { baseUrl: OPENAI, model: "gpt-transcribe" },
  },
  {
    id: "openai-gpt-4o-mini-transcribe",
    label: "OpenAI gpt-4o-mini-transcribe",
    provider: "openai-compatible",
    endpoint: { baseUrl: OPENAI, model: "gpt-4o-mini-transcribe" },
  },
  {
    id: "openai-whisper-1",
    label: "OpenAI whisper-1",
    provider: "openai-compatible",
    endpoint: { baseUrl: OPENAI, model: "whisper-1" },
  },
  {
    id: "groq-whisper-large-v3-turbo",
    label: "Groq whisper-large-v3-turbo",
    provider: "openai-compatible",
    endpoint: { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" },
  },
  {
    id: "xai-grok-voice-transcribe",
    label: "xAI grok-voice-transcribe-2.0",
    provider: "xai",
    endpoint: VOICE_TRANSCRIPTION_PROVIDER_DEFAULTS.xai,
  },
];

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").toLowerCase();
}

function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).origin;
  } catch {
    return normalizeBaseUrl(baseUrl);
  }
}

function isHttpVoiceInputProvider(
  provider: VoiceTranscriptionProvider,
): provider is HttpVoiceTranscriptionProvider {
  return provider !== "apple-on-device";
}

function endpointMatches(preset: VoiceInputPreset, target: VoiceInputProviderTarget): boolean {
  if (!isHttpVoiceInputProvider(target.provider)) return true;
  return (
    preset.endpoint !== undefined &&
    normalizeBaseUrl(preset.endpoint.baseUrl) === normalizeBaseUrl(target.baseUrl) &&
    preset.endpoint.model === target.model.trim()
  );
}

export function resolveVoiceInputPreset(target: VoiceInputProviderTarget): VoiceInputPresetId {
  const match = VOICE_INPUT_PRESETS.find(
    (preset) => preset.provider === target.provider && endpointMatches(preset, target),
  );
  return match?.id ?? "custom";
}

function clearKeyOnOriginChange(
  patch: VoiceInputTargetPatch,
  current: Pick<VoiceInputProviderTarget, "baseUrl">,
): VoiceInputTargetPatch {
  return patch.baseUrl !== undefined && originOf(patch.baseUrl) !== originOf(current.baseUrl)
    ? { ...patch, apiKey: "" }
    : patch;
}

export function voiceInputPresetPatch(
  id: VoiceInputPresetId,
  current: Pick<VoiceInputProviderTarget, "baseUrl">,
): VoiceInputTargetPatch | null {
  const preset = VOICE_INPUT_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) return null;
  return clearKeyOnOriginChange({ provider: preset.provider, ...preset.endpoint }, current);
}

export function voiceInputProviderPatch(
  provider: VoiceTranscriptionProvider,
  current: Pick<VoiceInputProviderTarget, "baseUrl">,
): VoiceInputTargetPatch {
  return isHttpVoiceInputProvider(provider)
    ? clearKeyOnOriginChange(
        { provider, ...VOICE_TRANSCRIPTION_PROVIDER_DEFAULTS[provider] },
        current,
      )
    : { provider };
}

export function availableVoiceInputPresets(
  appleOnDeviceAvailable: boolean,
): ReadonlyArray<VoiceInputPreset> {
  return appleOnDeviceAvailable
    ? VOICE_INPUT_PRESETS
    : VOICE_INPUT_PRESETS.filter((preset) => preset.provider !== "apple-on-device");
}
