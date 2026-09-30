export interface MidiNote { midi: number; time: number; duration: number; velocity: number; track: number; }
export interface MidiPerformance { notes: MidiNote[]; duration: number; }

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SECONDS = 480;
const MAX_NOTES = 10_000;
const MAX_NOTE_SECONDS = 2_400;
const SAMPLE_RATE = 32_000;
const WORK_CHUNK = 131_072;
const malformed = (): never => { throw new Error('MIDI 文件损坏或不完整，请重新导出。'); };
const unsupported = (detail: string): never => { throw new Error(`暂不支持${detail}的 MIDI，请先导出为音频。`); };

async function yieldToBrowser(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  signal?.throwIfAborted();
}

/** Bound every read before passing input to the synchronous third-party parser. */
async function validateSmf(data: ArrayBuffer, signal?: AbortSignal): Promise<{ lastTick: number; noteCount: number }> {
  signal?.throwIfAborted();
  if (!data.byteLength) throw new Error('MIDI 文件为空。');
  if (data.byteLength > MAX_BYTES) throw new Error('MIDI 不能超过 5 MB。');
  const bytes = new Uint8Array(data), view = new DataView(data);
  const chunkName = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 14 || chunkName(0) !== 'MThd') malformed();
  const headerSize = view.getUint32(4), format = view.getUint16(8), tracks = view.getUint16(10), division = view.getUint16(12);
  if (headerSize < 6 || headerSize > bytes.length - 8 || !tracks || tracks > 128) malformed();
  if (format !== 0 && format !== 1) unsupported('SMF 2 或其他格式');
  if (format === 0 && tracks !== 1) malformed();
  if (division & 0x8000) unsupported('SMPTE 时间格式');
  if (!division) malformed();
  let offset = 8 + headerSize, lastTick = 0, eventCount = 0, noteCount = 0;
  const tempos = new Map<number, number>();
  for (let track = 0; track < tracks; track++) {
    if (offset + 8 > bytes.length || chunkName(offset) !== 'MTrk') malformed();
    const size = view.getUint32(offset + 4);
    offset += 8;
    const end = offset + size;
    if (!size || end > bytes.length) malformed();
    const read = () => { if (offset >= end) malformed(); return bytes[offset++]; };
    const vlq = () => {
      let value = 0;
      for (let i = 0; i < 4; i++) { const byte = read(); value = value * 128 + (byte & 0x7f); if (!(byte & 0x80)) return value; }
      return malformed();
    };
    let tick = 0, running = 0, ended = false;
    const held = new Map<number, number>();
    const activeChannels = new Uint16Array(16);
    while (offset < end) {
      if (++eventCount > 50_000) throw new Error('MIDI 事件过多，请简化后重新导出。');
      if (eventCount % 512 === 0) await yieldToBrowser(signal);
      tick += vlq();
      if (!Number.isSafeInteger(tick)) malformed();
      let status = read();
      if (status < 0x80) { if (!running) malformed(); offset--; status = running; }
      else if (status < 0xf0) running = status;
      else running = 0;
      if (status === 0xff) {
        const type = read(), length = vlq();
        if (length > end - offset) malformed();
        const fixedLengths: Record<number, number> = { 0x00: 2, 0x20: 1, 0x21: 1, 0x2f: 0, 0x51: 3, 0x54: 5, 0x59: 2 };
        if (type in fixedLengths && length !== fixedLengths[type]) malformed();
        if (type === 0x58 && length !== 2 && length !== 4) malformed();
        // midi-file decodes text with String.fromCharCode.apply; cap its argument count.
        if (type >= 1 && type <= 7 && length > 32_768) throw new Error('MIDI 文本信息过大，请简化后重新导出。');
        if (type === 0x20 && bytes[offset] > 15) malformed();
        if (type === 0x21 && bytes[offset] !== 0) unsupported('多个 MIDI 端口');
        if (type === 0x54) unsupported('SMPTE 起始偏移');
        if (type === 0x51) {
          const tempo = bytes[offset] * 65536 + bytes[offset + 1] * 256 + bytes[offset + 2];
          if (!tempo) malformed();
          if (tempos.has(tick) && tempos.get(tick) !== tempo) unsupported('同一时刻存在冲突速度设置');
          tempos.set(tick, tempo);
        }
        offset += length;
        if (type === 0x2f) { ended = true; if (offset !== end) malformed(); }
        continue;
      }
      if (status === 0xf0 || status === 0xf7) unsupported('SysEx 系统消息');
      if (status >= 0xf0) malformed();
      const type = status >> 4, channel = status & 15;
      const first = read(), second = type === 0xc || type === 0xd ? 0 : read();
      if (first >= 128 || second >= 128) malformed();
      if (channel === 9) continue; // Percussion never supplies pitched reference notes.
      if (type === 0x9 && second > 0) {
        if (++noteCount > MAX_NOTES) throw new Error('MIDI 最多支持 10000 个旋律音符。');
        const key = channel * 128 + first;
        if (held.has(key)) unsupported('同一通道同音高重叠');
        held.set(key, tick); activeChannels[channel]++;
      } else if (type === 0x8 || type === 0x9) {
        const key = channel * 128 + first, start = held.get(key);
        if (start === undefined || tick <= start) malformed();
        held.delete(key); activeChannels[channel]--;
      } else if (type === 0xe && first + second * 128 !== 8192) unsupported('弯音');
      else if ((type === 0xa && second !== 0) || (type === 0xd && first !== 0)) unsupported('触后控制');
      else if (type === 0xc && activeChannels[channel]) unsupported('延音期间切换乐器');
      else if (type === 0xb) {
        if (first === 64 && second !== 0) unsupported('延音踏板');
        if ((first === 7 && second !== 100) || (first === 11 && second !== 127)) unsupported('音量或表情控制');
        if ([120, 123, 127].includes(first) && activeChannels[channel]) unsupported('提前关闭音符的控制消息');
        if ([124, 125, 126].includes(first)) unsupported('通道演奏模式控制');
        // Bank/program, pan and effects affect only the omitted GM timbre/mix.
        const timbreOnly = [0, 32, 10, 42, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 91, 92, 93, 94, 95];
        const reset = [120, 121, 123, 127].includes(first) && second === 0;
        const nullParameter = [98, 99, 100, 101].includes(first) && second === 127;
        if (![7, 11].includes(first) && !timbreOnly.includes(first) && !reset && !nullParameter && second !== 0) unsupported('暂未支持的演奏控制消息');
        // Data entry can tune the instrument even when its value is zero.
        if ([6, 38, 96, 97].includes(first)) unsupported('参数或调音控制');
      }
    }
    if (!ended || held.size) malformed();
    lastTick = Math.max(lastTick, tick);
  }
  if (offset !== bytes.length) malformed();
  if (!noteCount) throw new Error('MIDI 中没有可用的旋律音符，鼓轨不参与对齐。');
  return { lastTick, noteCount };
}

function validatePerformance(performance: MidiPerformance): void {
  if (!Number.isFinite(performance.duration) || performance.duration <= 0 || performance.duration > MAX_SECONDS) throw new Error('MIDI 时长需大于 0 秒且不超过 8 分钟。');
  if (!Array.isArray(performance.notes) || !performance.notes.length || performance.notes.length > MAX_NOTES) throw new Error('MIDI 需包含 1 至 10000 个旋律音符。');
  let noteSeconds = 0;
  for (const note of performance.notes) {
    if (![note.midi, note.time, note.duration, note.velocity, note.track].every(Number.isFinite)
      || !Number.isInteger(note.midi) || note.midi < 0 || note.midi > 127 || !Number.isInteger(note.track) || note.track < 0
      || note.time < 0 || note.duration < 1 / SAMPLE_RATE || note.time + note.duration > performance.duration + 1e-7
      || note.velocity <= 0 || note.velocity > 1) throw new Error('MIDI 音符时间、音高或力度无效。');
    noteSeconds += note.duration;
  }
  if (noteSeconds > MAX_NOTE_SECONDS) throw new Error('MIDI 复音量过大，请先导出为音频或减少声部。');
}

/** Parse PPQ-based SMF 0/1; no uploads, sound fonts or audio clock are involved. */
export async function parseMidi(data: ArrayBuffer, signal?: AbortSignal): Promise<MidiPerformance> {
  const validated = await validateSmf(data, signal);
  await yieldToBrowser(signal);
  const imported = await import('@tonejs/midi');
  // Vite resolves the ESM build; Node's tests resolve its CommonJS bundle.
  const Midi = imported.Midi ?? (imported as unknown as { default: typeof imported }).default.Midi;
  signal?.throwIfAborted();
  let parsed: InstanceType<typeof Midi>;
  try { parsed = new Midi(data); } catch { return malformed(); }
  signal?.throwIfAborted();
  // @tonejs/midi 2.x otherwise extrapolates the first later tempo backwards.
  if (!parsed.header.tempos.some(tempo => tempo.ticks === 0)) {
    parsed.header.tempos.unshift({ ticks: 0, bpm: 120 });
    parsed.header.update();
  }
  const notes: MidiNote[] = [];
  for (const [track, part] of parsed.tracks.entries()) {
    if (part.channel === 9) continue;
    for (const note of part.notes) {
      notes.push({ midi: note.midi, time: note.time, duration: note.duration, velocity: note.velocity, track });
      if (notes.length % 512 === 0) await yieldToBrowser(signal);
    }
  }
  // A library omission must not silently turn a corrupt performance into another one.
  if (notes.length !== validated.noteCount) malformed();
  notes.sort((a, b) => a.time - b.time || a.track - b.track || a.midi - b.midi);
  const performance = { notes, duration: parsed.header.ticksToSeconds(validated.lastTick) };
  validatePerformance(performance);
  signal?.throwIfAborted();
  return performance;
}

/** Fixed mono tone, normalized once; note-off envelopes end inside the MIDI duration. */
export async function renderMidiWav(performance: MidiPerformance, signal?: AbortSignal, onProgress?: (message: string) => void): Promise<Blob> {
  signal?.throwIfAborted();
  validatePerformance(performance);
  onProgress?.('合成 MIDI 音频…');
  await yieldToBrowser(signal);
  const length = Math.ceil(performance.duration * SAMPLE_RATE);
  const samples = new Float32Array(length);
  let work = 0, lastProgress = -1;
  for (const [index, note] of performance.notes.entries()) {
    const frequency = 440 * 2 ** ((note.midi - 69) / 12);
    const second = frequency * 2 < SAMPLE_RATE * .48 ? .12 : 0;
    const third = frequency * 3 < SAMPLE_RATE * .48 ? .06 : 0;
    const start = Math.ceil(note.time * SAMPLE_RATE), end = Math.min(length, Math.ceil((note.time + note.duration) * SAMPLE_RATE));
    const attack = Math.min(.006, note.duration / 8), release = Math.min(.018, note.duration / 4);
    for (let sample = start; sample < end; sample++) {
      const time = sample / SAMPLE_RATE - note.time;
      const up = Math.min(1, time / attack), down = Math.max(0, Math.min(1, (note.duration - time) / release));
      const envelope = up * up * (3 - 2 * up) * down * down * (3 - 2 * down);
      const phase = 2 * Math.PI * frequency * time;
      samples[sample] += note.velocity * envelope * (.82 * Math.sin(phase) + second * Math.sin(phase * 2) + third * Math.sin(phase * 3));
      if (++work >= WORK_CHUNK) { work = 0; await yieldToBrowser(signal); }
    }
    const progress = Math.floor((index + 1) / performance.notes.length * 100);
    if (progress !== lastProgress) { lastProgress = progress; onProgress?.(`合成 MIDI 音频… ${progress}%`); }
  }
  let peak = 0;
  for (let offset = 0; offset < length; offset += WORK_CHUNK) {
    for (let sample = offset; sample < Math.min(length, offset + WORK_CHUNK); sample++) peak = Math.max(peak, Math.abs(samples[sample]));
    await yieldToBrowser(signal);
  }
  if (!Number.isFinite(peak) || peak <= 1e-12) throw new Error('MIDI 音符过短或无法合成，请导出为音频。');
  const buffer = new ArrayBuffer(44 + length * 2), wav = new DataView(buffer);
  const ascii = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) wav.setUint8(offset + i, value.charCodeAt(i)); };
  ascii(0, 'RIFF'); wav.setUint32(4, 36 + length * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
  wav.setUint32(24, SAMPLE_RATE, true); wav.setUint32(28, SAMPLE_RATE * 2, true);
  wav.setUint16(32, 2, true); wav.setUint16(34, 16, true); ascii(36, 'data'); wav.setUint32(40, length * 2, true);
  const gain = .88 / peak;
  for (let offset = 0; offset < length; offset += WORK_CHUNK) {
    for (let sample = offset; sample < Math.min(length, offset + WORK_CHUNK); sample++) {
      wav.setInt16(44 + sample * 2, Math.round(Math.max(-1, Math.min(1, samples[sample] * gain)) * 32767), true);
    }
    await yieldToBrowser(signal);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
