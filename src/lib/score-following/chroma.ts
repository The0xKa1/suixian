import type { AudioScoreFrame } from './types.ts';

export function normalizeChroma(values: readonly number[]): number[] {
  const safe = Array.from({ length: 12 }, (_, i) => Number.isFinite(values[i]) ? Math.max(0, values[i]) : 0);
  const norm = Math.hypot(...safe);
  return norm > 1e-12 ? safe.map((value) => value / norm) : safe;
}

export function chromaSimilarity(a: readonly number[], b: readonly number[]): number {
  const left = normalizeChroma(a);
  const right = normalizeChroma(b);
  return Math.min(1, left.reduce((sum, value, i) => sum + value * right[i], 0));
}

/** A small harmonic template, not a trained acoustic model. */
export function midiToChroma(midi: readonly number[]): number[] {
  const values = Array<number>(12).fill(0);
  for (const pitch of midi) {
    if (!Number.isFinite(pitch) || pitch < 0 || pitch > 127) continue;
    values[Math.round(pitch) % 12] += 1;
    values[(Math.round(pitch) + 7) % 12] += 0.12;
  }
  return normalizeChroma(values);
}

/** Shared by microphone input and offline PCM tests: Hann FFT -> peak chroma. */
export function createAudioFeatureExtractor(sampleRate: number, fftSize = 8192) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || fftSize < 2048 || (fftSize & (fftSize - 1))) {
    throw new Error('不支持的音频采样参数');
  }
  const real = new Float64Array(fftSize);
  const imag = new Float64Array(fftSize);
  const magnitudes = new Float64Array(fftSize / 2);
  const window = Float64Array.from({ length: fftSize }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftSize - 1)));
  const reverse = new Uint32Array(fftSize);
  const bits = Math.log2(fftSize);
  for (let i = 0; i < fftSize; i++) {
    let value = i;
    for (let bit = 0; bit < bits; bit++) { reverse[i] = (reverse[i] << 1) | (value & 1); value >>= 1; }
  }
  let previousChroma = Array<number>(12).fill(0);
  let previousRms = 0;
  let previousOnset = -Infinity;

  return {
    process(samples: Float32Array, timestampMs: number): AudioScoreFrame {
      if (samples.length !== fftSize) throw new Error('音频帧长度不匹配');
      let energy = 0;
      let mean = 0;
      for (let i = 0; i < fftSize; i++) mean += samples[i];
      mean /= fftSize;
      for (let i = 0; i < fftSize; i++) {
        const value = samples[i] - mean;
        energy += value * value;
        real[reverse[i]] = value * window[i];
        imag[i] = 0;
      }
      for (let size = 2; size <= fftSize; size *= 2) {
        const half = size / 2;
        const angle = -2 * Math.PI / size;
        const stepReal = Math.cos(angle);
        const stepImag = Math.sin(angle);
        for (let start = 0; start < fftSize; start += size) {
          let twiddleReal = 1;
          let twiddleImag = 0;
          for (let j = 0; j < half; j++) {
            const a = start + j;
            const b = a + half;
            const tr = real[b] * twiddleReal - imag[b] * twiddleImag;
            const ti = real[b] * twiddleImag + imag[b] * twiddleReal;
            real[b] = real[a] - tr;
            imag[b] = imag[a] - ti;
            real[a] += tr;
            imag[a] += ti;
            const nextReal = twiddleReal * stepReal - twiddleImag * stepImag;
            twiddleImag = twiddleReal * stepImag + twiddleImag * stepReal;
            twiddleReal = nextReal;
          }
        }
      }
      for (let i = 0; i < magnitudes.length; i++) magnitudes[i] = Math.hypot(real[i], imag[i]);
      const chroma = Array<number>(12).fill(0);
      const minBin = Math.max(2, Math.floor(65 * fftSize / sampleRate));
      const maxBin = Math.min(magnitudes.length - 2, Math.ceil(2200 * fftSize / sampleRate));
      for (let i = minBin; i <= maxBin; i++) {
        if (magnitudes[i] <= magnitudes[i - 1] || magnitudes[i] < magnitudes[i + 1]) continue;
        // Parabolic interpolation of log magnitude resolves low guitar notes between FFT bins.
        const a = Math.log(Math.max(1e-12, magnitudes[i - 1]));
        const b = Math.log(Math.max(1e-12, magnitudes[i]));
        const c = Math.log(Math.max(1e-12, magnitudes[i + 1]));
        const denominator = a - 2 * b + c;
        const delta = denominator ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denominator)) : 0;
        const frequency = (i + delta) * sampleRate / fftSize;
        const midi = 69 + 12 * Math.log2(frequency / 440);
        const rounded = Math.round(midi);
        const tuningWeight = Math.exp(-0.5 * ((midi - rounded) / 0.22) ** 2);
        chroma[((rounded % 12) + 12) % 12] += magnitudes[i] ** 1.5 * tuningWeight;
      }
      const rms = Math.sqrt(energy / fftSize);
      const normalized = normalizeChroma(chroma);
      const pitchChange = 1 - chromaSimilarity(normalized, previousChroma);
      const attack = rms > Math.max(0.006, previousRms * 1.45);
      const onset = rms >= 0.006 && timestampMs - previousOnset >= 100 && (attack || pitchChange > 0.24);
      if (onset) previousOnset = timestampMs;
      previousChroma = normalized;
      previousRms = rms;
      return { timestampMs, chroma: normalized, rms, onset };
    },
  };
}
