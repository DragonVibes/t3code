import type { VoiceInputPhase, VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";
import { ComposerVoiceInputControl } from "./ComposerVoiceInputControl";

const phaseState = (phase: VoiceInputPhase): VoiceInputState => ({
  phase,
  error: null,
  errorAction: null,
});

// Every toggle moves the phase, so a click the control should have ignored shows up.
const TOGGLED: Record<VoiceInputPhase, VoiceInputPhase> = {
  idle: "recording",
  error: "recording",
  preparing: "idle",
  recording: "transcribing",
  transcribing: "idle",
};

const notStarted = () => null;

function Host({
  initialPhase,
  readStartedAt = notStarted,
}: {
  initialPhase: VoiceInputPhase;
  readStartedAt?: () => number | null;
}) {
  const [phase, setPhase] = useState(initialPhase);
  return (
    <div className="flex w-80 shrink-0 flex-nowrap items-center justify-end gap-2">
      <ComposerVoiceInputControl
        state={phaseState(phase)}
        shortcutLabel="⌘⇧Space"
        announcement=""
        readStartedAt={readStartedAt}
        readLevel={() => 0}
        onToggle={() => setPhase((current) => TOGGLED[current])}
        onCancel={() => setPhase("idle")}
      />
    </div>
  );
}

function click(element: Element) {
  return act(async () => (element as HTMLElement).click());
}

describe("ComposerVoiceInputControl", () => {
  it("keeps the stop control exactly where the mic button was, so a second click in the same spot stops", async () => {
    await using screen = await render(<Host initialPhase="idle" />);
    const mic = screen.getByRole("button", { name: "Voice input" }).element();
    const idleRect = mic.getBoundingClientRect();
    await click(mic);

    const stop = screen.getByRole("button", { name: "Stop and transcribe" }).element();
    expect(stop.getBoundingClientRect()).toEqual(idleRect);
    screen.getByRole("button", { name: "Cancel voice input" }).element();

    await click(stop);
    screen.getByRole("button", { name: "Transcribing" }).element();
  });

  it("keeps the mic focusable but inert while transcribing and leaves cancel live", async () => {
    await using screen = await render(<Host initialPhase="transcribing" />);
    const mic = screen.getByRole("button", { name: "Transcribing" }).element() as HTMLButtonElement;
    expect(mic.disabled).toBe(false);
    expect(mic.getAttribute("aria-disabled")).toBe("true");
    mic.focus();
    expect(document.activeElement).toBe(mic);

    await click(mic);
    expect(screen.getByRole("button", { name: "Transcribing" }).query()).toBe(mic);

    await click(screen.getByRole("button", { name: "Cancel voice input" }).element());
    screen.getByRole("button", { name: "Voice input" }).element();
    expect(screen.getByRole("button", { name: "Cancel voice input" }).query()).toBeNull();
  });

  it("counts recording time from the recorder's start", async () => {
    let startedAt: number | null = null;
    await using screen = await render(<Host initialPhase="idle" readStartedAt={() => startedAt} />);
    using _timers = fakeTimers();
    startedAt = Date.now();
    await click(screen.getByRole("button", { name: "Voice input" }).element());
    expect(screen.container.textContent).toContain("0:00");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(62_000);
    });
    expect(screen.container.textContent).toContain("1:02");
  });
});
