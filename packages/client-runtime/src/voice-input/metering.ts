export const VOICE_WAVEFORM_SAMPLE_COUNT = 64;

const VOICE_NOISE_FLOOR_DECIBELS = -60;
const VOICE_NOISE_FLOOR_AMPLITUDE = 10 ** (VOICE_NOISE_FLOOR_DECIBELS / 20);

export function normalizeVoiceInputDecibels(decibels: number | undefined) {
  if (decibels === undefined || !Number.isFinite(decibels)) return 0;
  if (decibels <= VOICE_NOISE_FLOOR_DECIBELS) return 0;
  if (decibels >= 0) return 1;

  const amplitude = 10 ** (decibels / 20);
  return Math.sqrt((amplitude - VOICE_NOISE_FLOOR_AMPLITUDE) / (1 - VOICE_NOISE_FLOOR_AMPLITUDE));
}

/** Decibels of a PCM sample window in the Web Audio byte range (128 is silence). */
export function voiceInputDecibelsFromByteSamples(samples: ArrayLike<number>): number {
  if (samples.length === 0) return Number.NEGATIVE_INFINITY;
  let sumOfSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const centered = ((samples[index] ?? 128) - 128) / 128;
    sumOfSquares += centered * centered;
  }
  const rms = Math.sqrt(sumOfSquares / samples.length);
  return rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms);
}
