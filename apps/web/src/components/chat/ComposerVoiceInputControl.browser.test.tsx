import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../../test/render";
import { ComposerVoiceInputControl } from "./ComposerVoiceInputControl";

const IDLE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const PREPARING: VoiceInputState = { phase: "preparing", error: null, errorAction: null };
const RECORDING: VoiceInputState = { phase: "recording", error: null, errorAction: null };
const TRANSCRIBING: VoiceInputState = { phase: "transcribing", error: null, errorAction: null };

function control(
  state: VoiceInputState,
  overrides: Partial<React.ComponentProps<typeof ComposerVoiceInputControl>> = {},
) {
  return (
    <div className="flex w-80 shrink-0 flex-nowrap items-center justify-end gap-2">
      <ComposerVoiceInputControl
        state={state}
        shortcutLabel="⌘⇧Space"
        errorContext={{ secureContext: true, permissionHost: "browser" }}
        readStartedAt={() => null}
        readLevel={() => 0}
        onToggle={() => {}}
        onCancel={() => {}}
        onOpenSettings={() => {}}
        {...overrides}
      />
    </div>
  );
}

const toggleButton = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].at(-1)!;

describe("ComposerVoiceInputControl", () => {
  it("keeps the stop control exactly where the mic button was, so a second click in the same spot stops", async () => {
    const onToggle = vi.fn();
    await using screen = await render(control(IDLE, { onToggle }));
    const idleButton = toggleButton(screen.container);
    expect(idleButton.getAttribute("aria-label")).toBe("Voice input");
    const idleRect = idleButton.getBoundingClientRect();
    await act(async () => idleButton.click());
    expect(onToggle).toHaveBeenCalledTimes(1);

    await screen.rerender(control(RECORDING, { onToggle }));
    const stopButton = toggleButton(screen.container);
    expect(stopButton.getAttribute("aria-label")).toBe("Stop and transcribe");
    const recordingRect = stopButton.getBoundingClientRect();
    expect(recordingRect.left).toBe(idleRect.left);
    expect(recordingRect.top).toBe(idleRect.top);
    expect(recordingRect.width).toBe(idleRect.width);
    expect(recordingRect.height).toBe(idleRect.height);
    expect(screen.container.querySelector('[aria-label="Cancel voice input"]')).not.toBeNull();

    await act(async () => stopButton.click());
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("disables the stop control while transcribing but keeps cancel available", async () => {
    const onCancel = vi.fn();
    await using screen = await render(control(TRANSCRIBING, { onCancel }));
    expect(toggleButton(screen.container).disabled).toBe(true);
    expect(screen.container.querySelector('[role="status"]')).not.toBeNull();
    const cancel = screen.container.querySelector<HTMLButtonElement>(
      '[aria-label="Cancel voice input"]',
    )!;
    expect(cancel.disabled).toBe(false);
    await act(async () => cancel.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("counts recording time from the recorder's start", async () => {
    let startedAt: number | null = null;
    await using screen = await render(control(PREPARING, { readStartedAt: () => startedAt }));
    vi.useFakeTimers();
    try {
      startedAt = Date.now();
      await screen.rerender(control(RECORDING, { readStartedAt: () => startedAt }));
      expect(screen.container.textContent).toContain("0:00");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(62_000);
      });
      expect(screen.container.textContent).toContain("1:02");
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains a blocked microphone and offers the fix the platform has", async () => {
    const denied: VoiceInputState = {
      phase: "error",
      error: "Microphone access is required for voice input.",
      errorAction: "settings",
    };
    const onOpenSettings = vi.fn();
    await using screen = await render(
      control(denied, {
        onOpenSettings,
        errorContext: { secureContext: true, permissionHost: "macos" },
      }),
    );
    expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
      "System Settings",
    );
    const open = [...screen.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Open settings",
    )!;
    await act(async () => open.click());
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    const onToggle = vi.fn();
    await screen.rerender(
      control(
        { phase: "error", error: "No speech was detected.", errorAction: "retry" },
        { onToggle },
      ),
    );
    expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
      "No speech was detected.",
    );
    const retry = [...screen.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    )!;
    await act(async () => retry.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
