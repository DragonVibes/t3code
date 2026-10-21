import type { ServerSettingsPatch, VoiceTranscriptionProvider } from "@t3tools/contracts";
import { XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ScopedSwitch } from "./ScopedSwitch";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import {
  availableVoiceInputPresets,
  resolveVoiceInputPreset,
  VOICE_INPUT_PROVIDER_LABELS,
  voiceInputPresetPatch,
  voiceInputProviderPatch,
  type VoiceInputPresetId,
} from "./voiceInputSettings.logic";

type VoiceTranscriptionPatch = NonNullable<ServerSettingsPatch["voiceTranscription"]>;

const SETTING_KEYS = ["voiceTranscription"] as const;
const CONTROL_CLASSNAME = "w-full max-w-full @min-[32rem]/settings-row:w-72";

const APPLE_NOTE =
  "Apple on-device transcribes on the Mac running T3 Code. The first use of a new language downloads Apple's language model.";
const APPLE_UNAVAILABLE_NOTE = "Needs macOS 26 or later on the machine running T3 Code.";

export function VoiceInputSettings() {
  const settings = useScopedSettings((unified) => unified.voiceTranscription);
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(SETTING_KEYS);
  const { connectedEnvironments } = useSettingsScope();
  const hasServerTargets = connectedEnvironments.length > 0;
  const appleOnDeviceAvailable =
    hasServerTargets &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.appleOnDeviceTranscription === true,
    );
  const update = (patch: VoiceTranscriptionPatch) => updateSettings({ voiceTranscription: patch });

  const appleSelected = settings.provider === "apple-on-device";
  const appleBlocked = appleSelected && !appleOnDeviceAvailable;
  const providers: ReadonlyArray<VoiceTranscriptionProvider> = [
    ...(appleOnDeviceAvailable || appleSelected ? (["apple-on-device"] as const) : []),
    "openai-compatible",
    "xai",
  ];
  const presets = availableVoiceInputPresets(appleOnDeviceAvailable);
  const presetId = resolveVoiceInputPreset(settings);
  const presetLabel = presets.find((preset) => preset.id === presetId)?.label ?? "Custom";
  const keyConfigured = settings.apiKey.length > 0;

  return (
    <SettingsSection id="voice-input" title="Voice input">
      <SettingsRow
        serverScoped
        settingKeys={SETTING_KEYS}
        {...searchableSetting("voice-input-enabled")}
        description="Dictate into the composer with the microphone button or the composer.toggleDictation shortcut. The recording goes to this environment, which transcribes it with the provider below, and the text is inserted for you to review before sending."
        control={
          hasServerTargets ? (
            <ScopedSwitch
              settingKeys={SETTING_KEYS}
              checked={settings.enabled}
              onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
              aria-label="Enable voice input"
            />
          ) : (
            <span className="text-sm text-muted-foreground">
              Connect an environment to set up voice input.
            </span>
          )
        }
      />
      {hasServerTargets ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={SETTING_KEYS}
            {...searchableSetting("voice-input-provider")}
            description={[
              "Hosted providers bill per use through the API key below. A local whisper.cpp server needs no key.",
              ...(appleOnDeviceAvailable || appleSelected ? [APPLE_NOTE] : []),
              ...(appleBlocked ? [APPLE_UNAVAILABLE_NOTE] : []),
            ].join(" ")}
            control={
              <Select
                value={settings.provider}
                onValueChange={(value) => {
                  if (value !== null && value !== settings.provider) {
                    update(voiceInputProviderPatch(value as VoiceTranscriptionProvider, settings));
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className={CONTROL_CLASSNAME}
                  aria-label="Voice input provider"
                >
                  <SelectValue>
                    {mixed ? "Mixed" : VOICE_INPUT_PROVIDER_LABELS[settings.provider]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {providers.map((provider) => (
                    <SelectItem
                      hideIndicator
                      key={provider}
                      value={provider}
                      disabled={provider === "apple-on-device" && !appleOnDeviceAvailable}
                    >
                      {VOICE_INPUT_PROVIDER_LABELS[provider]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          {appleSelected ? null : (
            <SettingsRow
              serverScoped
              settingKeys={SETTING_KEYS}
              {...searchableSetting("voice-input-model")}
              description="Pick a preset or point Base URL at any OpenAI-compatible endpoint. Local whisper.cpp is a whisper.cpp server on the machine running T3 Code, started with `whisper-server --inference-path /v1/audio/transcriptions -m <model>`; uploads are 16 kHz WAV, so ffmpeg and --convert are not needed. OpenAI retires gpt-4o-mini-transcribe and whisper-1 on 2027-02-26."
              control={
                <div className={`flex flex-col gap-2 ${CONTROL_CLASSNAME}`}>
                  <Select
                    value={presetId}
                    onValueChange={(value) => {
                      const patch = voiceInputPresetPatch(value as VoiceInputPresetId, settings);
                      if (patch) update(patch);
                    }}
                  >
                    <SelectTrigger size="sm" className="w-full" aria-label="Voice input preset">
                      <SelectValue>{mixed ? "Mixed" : presetLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {presets.map((preset) => (
                        <SelectItem hideIndicator key={preset.id} value={preset.id}>
                          {preset.label}
                        </SelectItem>
                      ))}
                      <SelectItem hideIndicator value="custom">
                        Custom
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                  <DraftInput
                    size="sm"
                    aria-label="Base URL"
                    placeholder="https://api.openai.com/v1"
                    value={settings.baseUrl}
                    onCommit={(next) => update({ baseUrl: next })}
                    spellCheck={false}
                  />
                  <DraftInput
                    size="sm"
                    aria-label="Model"
                    placeholder="gpt-transcribe"
                    value={settings.model}
                    onCommit={(next) => update({ model: next })}
                    spellCheck={false}
                  />
                </div>
              }
            />
          )}
          <SettingsRow
            serverScoped
            settingKeys={SETTING_KEYS}
            {...searchableSetting("voice-input-language")}
            description="ISO 639-1 code such as en or de. Blank detects the language automatically; with Apple on-device, blank uses the Mac's system language."
            control={
              <DraftInput
                size="sm"
                className={CONTROL_CLASSNAME}
                aria-label="Voice input language"
                placeholder="Auto-detect"
                value={settings.language}
                onCommit={(next) => update({ language: next })}
                spellCheck={false}
              />
            }
          />
          {appleSelected ? null : (
            <SettingsRow
              serverScoped
              settingKeys={SETTING_KEYS}
              {...searchableSetting("voice-input-api-key")}
              description="Kept in this environment's secret store and never sent to clients. Leave it empty for a local whisper.cpp server."
              control={
                <div className={`flex items-center gap-2 ${CONTROL_CLASSNAME}`}>
                  <SecretInput
                    size="sm"
                    className="min-w-0 flex-1"
                    aria-label="Voice input API key"
                    configured={keyConfigured}
                    value=""
                    onCommit={(next) => update({ apiKey: next })}
                  />
                  {keyConfigured ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost-destructive"
                      onClick={() => update({ apiKey: "" })}
                      aria-label="Clear voice input API key"
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              }
            />
          )}
        </>
      ) : null}
    </SettingsSection>
  );
}
