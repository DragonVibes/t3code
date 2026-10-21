import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { toastManager } from "../ui/toast";
import { ComposerBannerStack } from "./ComposerBannerStack";
import { voiceInputBannerItem } from "./ComposerVoiceInputBanner";

const denied = {
  phase: "error",
  error: "Microphone access is required for voice input.",
  errorAction: "settings",
} as const;

function click(element: Element) {
  return act(async () => (element as HTMLElement).click());
}

describe("voiceInputBannerItem", () => {
  it("explains a failed System Settings launch instead of leaving a rejected promise", async () => {
    using add = vi.spyOn(toastManager, "add").mockImplementation(() => "toast");
    const item = voiceInputBannerItem({
      state: denied,
      errorContext: { secureContext: true, permissionHost: "macos" },
      openSettings: async () => {
        throw new Error("Unable to open System Settings.");
      },
      onRetry: () => {},
      onDismiss: () => {},
    });
    await using screen = await render(<ComposerBannerStack items={item ? [item] : []} />);
    expect(screen.getByRole("alert").element().textContent).toContain("System Settings");

    await click(screen.getByRole("button", { name: "Open settings" }).element());
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "Unable to open System Settings." }),
    );
  });

  it.each([
    ["Open settings", denied, "macos"],
    [
      "Retry",
      { phase: "error", error: "Upload failed.", errorAction: "retry-transcription" },
      "browser",
    ],
  ] as const)("leaves focus in the composer when %s is pressed", async (name, state, host) => {
    const item = voiceInputBannerItem({
      state,
      errorContext: { secureContext: true, permissionHost: host },
      openSettings: async () => {},
      onRetry: () => {},
      onDismiss: () => {},
    });
    await using screen = await render(
      <>
        <textarea aria-label="Composer" />
        <ComposerBannerStack items={item ? [item] : []} />
      </>,
    );
    const composer = screen.getByRole("textbox", { name: "Composer" }).element();
    (composer as HTMLTextAreaElement).focus();
    await userEvent.click(screen.getByRole("button", { name }));
    expect(document.activeElement).toBe(composer);
  });

  it("offers Retry for a kept recording and nothing while voice input runs", async () => {
    const onRetry = vi.fn();
    const item = voiceInputBannerItem({
      state: { phase: "error", error: "Upload failed.", errorAction: "retry-transcription" },
      errorContext: { secureContext: true, permissionHost: "browser" },
      onRetry,
      onDismiss: () => {},
    });
    await using screen = await render(<ComposerBannerStack items={item ? [item] : []} />);
    expect(screen.getByRole("alert").element().textContent).toContain("Upload failed.");
    await click(screen.getByRole("button", { name: "Retry" }).element());
    expect(onRetry).toHaveBeenCalledTimes(1);

    expect(
      voiceInputBannerItem({
        state: { phase: "recording", error: null, errorAction: null },
        onRetry,
        onDismiss: () => {},
      }),
    ).toBeNull();
  });
});
