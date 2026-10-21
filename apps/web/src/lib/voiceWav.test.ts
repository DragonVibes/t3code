import { describe, expect, it } from "vite-plus/test";

import { encodeWavPcm16 } from "./voiceWav";

const ascii = (view: DataView, offset: number, length: number) =>
  String.fromCharCode(...Array.from({ length }, (_, index) => view.getUint8(offset + index)));

describe("encodeWavPcm16", () => {
  it("writes a canonical 16-bit mono PCM header sized to the samples", () => {
    const buffer = encodeWavPcm16([0, 1, -1, 0.5], 16_000);
    const view = new DataView(buffer);

    expect(buffer.byteLength).toBe(44 + 4 * 2);
    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 8);
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(8);
  });

  it("scales and clamps samples to little-endian signed 16-bit", () => {
    const view = new DataView(encodeWavPcm16([0, 1, -1, 0.5, 2, -2], 16_000));
    const sample = (index: number) => view.getInt16(44 + index * 2, true);
    expect([sample(0), sample(1), sample(2), sample(3), sample(4), sample(5)]).toEqual([
      0, 32_767, -32_768, 16_383, 32_767, -32_768,
    ]);
    expect(view.getUint8(44 + 2)).toBe(0xff);
    expect(view.getUint8(44 + 3)).toBe(0x7f);
  });
});
