import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { CircleAlertIcon, MicIcon, XIcon } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import {
  canOpenMicrophoneSystemSettings,
  openMicrophoneSystemSettings,
} from "~/lib/microphoneSettings";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  resolveVoiceInputErrorPresentation,
  type VoiceInputErrorContext,
} from "./voiceInputErrorPresentation";

/** At most 15 meter updates a second, and none outside the recording phase. */
export const VOICE_METER_INTERVAL_MS = 66;
const VOICE_METER_BAR_COUNT = 5;
const VOICE_METER_REST_SCALE = 0.15;

const BROWSER_ERROR_CONTEXT: VoiceInputErrorContext = {
  secureContext: typeof window !== "undefined" && window.isSecureContext,
  canOpenSystemSettings: canOpenMicrophoneSystemSettings,
};

export function formatVoiceElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function keepEditorSelection(event: React.PointerEvent) {
  event.preventDefault();
}

function VoiceLevelBars({ readLevel }: { readLevel: () => number }) {
  const barsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = barsRef.current;
    if (!container) return;
    const bars = Array.from(container.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    const history = Array.from<number>({ length: bars.length }).fill(0);
    const paint = () => {
      bars.forEach((bar, index) => {
        bar.style.transform = `scaleY(${Math.max(VOICE_METER_REST_SCALE, history[index] ?? 0)})`;
      });
    };
    paint();
    const interval = setInterval(() => {
      history.shift();
      history.push(readLevel());
      paint();
    }, VOICE_METER_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [readLevel]);
  return (
    <div ref={barsRef} className="flex h-4 items-center gap-0.5" aria-hidden>
      {Array.from({ length: VOICE_METER_BAR_COUNT }, (_, index) => (
        <span key={index} className="h-full w-0.75 origin-center rounded-full bg-destructive" />
      ))}
    </div>
  );
}

function RecordingDot({ muted = false }: { muted?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 rounded-full", muted ? "bg-muted-foreground/50" : "bg-destructive")}
    />
  );
}

function VoiceElapsed({
  readStartedAt,
  running,
}: {
  readStartedAt: () => number | null;
  running: boolean;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      const startedAt = readStartedAt();
      setSeconds(startedAt === null ? 0 : (Date.now() - startedAt) / 1000);
    }, 1000);
    return () => clearInterval(interval);
  }, [running, readStartedAt]);
  return (
    <span className="w-8 text-right text-xs text-muted-foreground tabular-nums">
      {formatVoiceElapsed(seconds)}
    </span>
  );
}

export interface ComposerVoiceInputControlProps {
  readonly state: VoiceInputState;
  readonly shortcutLabel: string | null;
  readonly readStartedAt: () => number | null;
  readonly readLevel: () => number;
  /** Starts recording, or stops and transcribes. The same button in the same spot does both. */
  readonly onToggle: () => void;
  readonly onCancel: () => void;
  readonly errorContext?: VoiceInputErrorContext;
  readonly onOpenSettings?: () => void;
}

export const ComposerVoiceInputControl = memo(function ComposerVoiceInputControl(
  props: ComposerVoiceInputControlProps,
) {
  const { state, shortcutLabel, readStartedAt, readLevel, onToggle, onCancel } = props;
  const errorContext = props.errorContext ?? BROWSER_ERROR_CONTEXT;
  const onOpenSettings = props.onOpenSettings ?? openMicrophoneSystemSettings;
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const phase = state.phase;
  const active = phase === "preparing" || phase === "recording" || phase === "transcribing";
  const error = resolveVoiceInputErrorPresentation(state, errorContext);
  const shortcutSuffix = shortcutLabel ? ` (${shortcutLabel})` : "";
  const toggleLabel =
    phase === "recording"
      ? "Stop and transcribe"
      : phase === "transcribing"
        ? "Transcribing"
        : phase === "preparing"
          ? "Starting voice input"
          : "Voice input";

  return (
    <div className="flex min-w-0 items-center gap-1" data-voice-input-phase={phase}>
      {active ? (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Cancel voice input"
                  onPointerDown={keepEditorSelection}
                  onClick={onCancel}
                />
              }
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipPopup>Cancel voice input (Esc)</TooltipPopup>
          </Tooltip>
          <div className="flex h-7 w-8 items-center justify-center">
            {phase === "transcribing" ? (
              <Spinner size="sm" tone="muted" />
            ) : phase === "recording" && !prefersReducedMotion ? (
              <VoiceLevelBars readLevel={readLevel} />
            ) : (
              <RecordingDot muted={phase !== "recording"} />
            )}
          </div>
          <VoiceElapsed readStartedAt={readStartedAt} running={phase === "recording"} />
        </>
      ) : error ? (
        <div className="flex min-w-0 items-center gap-1 text-xs text-destructive">
          <Tooltip>
            <TooltipTrigger
              render={<span className="flex min-w-0 items-center gap-1" role="alert" />}
            >
              <CircleAlertIcon className="size-3.5 shrink-0" />
              <span className="max-w-56 truncate">{error.message}</span>
            </TooltipTrigger>
            <TooltipPopup>{error.message}</TooltipPopup>
          </Tooltip>
          {error.action === "open-settings" ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                void onOpenSettings();
              }}
            >
              Open settings
            </Button>
          ) : error.action === "retry" ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onPointerDown={keepEditorSelection}
              onClick={onToggle}
            >
              Retry
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss voice input error"
            onPointerDown={keepEditorSelection}
            onClick={onCancel}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={toggleLabel}
              aria-pressed={phase === "recording"}
              disabled={phase === "preparing" || phase === "transcribing"}
              onPointerDown={keepEditorSelection}
              onClick={onToggle}
            />
          }
        >
          <MicIcon className={cn(phase === "recording" && "text-destructive")} />
        </TooltipTrigger>
        <TooltipPopup>{`${toggleLabel}${shortcutSuffix}`}</TooltipPopup>
      </Tooltip>
    </div>
  );
});
