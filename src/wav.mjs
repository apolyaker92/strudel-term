// Minimal 16-bit PCM WAV writer. Enough to hand a render to any other program.

const HEADER_BYTES = 44;

function clampToInt16(sample) {
  const clamped = Math.max(-1, Math.min(1, sample));
  // asymmetric on purpose: -1 maps to -32768, +1 to 32767
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

/**
 * @param channels array of Float32Array, one per channel, all the same length
 */
export function encodeWav(channels, sampleRate) {
  const channelCount = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * channelCount * 2;
  const buffer = Buffer.alloc(HEADER_BYTES + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM header size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channelCount * 2, 28); // byte rate
  buffer.writeUInt16LE(channelCount * 2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  let offset = HEADER_BYTES;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      buffer.writeInt16LE(Math.round(clampToInt16(channels[channel][frame])), offset);
      offset += 2;
    }
  }
  return buffer;
}
