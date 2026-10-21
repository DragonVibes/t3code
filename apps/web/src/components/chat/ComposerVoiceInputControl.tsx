import type { VoiceInputPhase, VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { MicIcon, XIcon } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const VOICE_METER_INTERVAL_MS = 66;
const VOICE_METER_BAR_COUNT = 5;
const VOICE_METER_REST_SCALE = 0.15;

const TOGGLE_LABELS: Record<VoiceInputPhase, string> = {
  idle: "Voice input",
  error: "Voice input",
  preparing: "Starting voice input",
  recording: "Stop and transcribe",
  transcribing: "Transcribing",
};

function formatVoiceElapsed(seconds: number): string {
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
  /** Read by the visually hidden status region; errors are announced by their banner. */
  readonly announcement: string;
  readonly readStartedAt: () => number | null;
  readonly readLevel: () => number;
  readonly onToggle: () => void;
  readonly onCancel: () => void;
}

export const ComposerVoiceInputControl = memo(function ComposerVoiceInputControl(
  props: ComposerVoiceInputControlProps,
) {
  const { state, shortcutLabel, announcement, readStartedAt, readLevel, onToggle, onCancel } =
    props;
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const phase = state.phase;
  const active = phase === "preparing" || phase === "recording" || phase === "transcribing";
  // aria-disabled rather than disabled, so keyboard focus survives the transition.
  const toggleInert = phase === "preparing" || phase === "transcribing";
  const toggleLabel = TOGGLE_LABELS[phase];
  const toggleTooltip =
    shortcutLabel && !toggleInert ? `${toggleLabel} (${shortcutLabel})` : toggleLabel;

  return (
    <div className="flex min-w-0 items-center gap-1" data-voice-input-phase={phase}>
      <span role="status" className="sr-only">
        {announcement}
      </span>
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
            <TooltipPopup>Cancel voice input</TooltipPopup>
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
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={toggleLabel}
              aria-disabled={toggleInert || undefined}
              onPointerDown={keepEditorSelection}
              onClick={() => {
                if (!toggleInert) onToggle();
              }}
            />
          }
        >
          <MicIcon className={cn(phase === "recording" && "text-destructive")} />
        </TooltipTrigger>
        <TooltipPopup>{toggleTooltip}</TooltipPopup>
      </Tooltip>
    </div>
  );
});
