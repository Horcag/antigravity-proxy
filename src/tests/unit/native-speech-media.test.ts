import { describe, expect, it } from 'vitest';
import { boundedLivePcm, decodeSpeechAudio } from '../../modules/proxy-gateway/server/speech/native-speech-media';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function wav() {
  const data = Buffer.alloc(3200);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
describe('native speech media boundary', () => {
  it('decodes a real PCM WAV through ffmpeg without temporary files', async () => {
    const decoded = await decodeSpeechAudio(wav(), new AbortController().signal);
    expect(decoded).toEqual(Buffer.alloc(3200));
  });
  it('rejects invalid audio and a playlist referencing an external file', async () => {
    await expect(decodeSpeechAudio(Buffer.from('invalid'), new AbortController().signal)).rejects.toMatchObject({ status: 400 });
    await expect(decodeSpeechAudio(Buffer.from("ffconcat version 1.0\nfile '/etc/passwd'\n"), new AbortController().signal)).rejects.toMatchObject({ status: 400 });
  });
  it('honors cancellation before starting a decoder', () => {
    const abort = new AbortController(); abort.abort();
    expect(() => decodeSpeechAudio(wav(), abort.signal)).toThrow();
  });
  it('reaps its exact decoder even if it ignores SIGTERM after cancellation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'native-speech-decoder-'));
    const executable = path.join(directory, 'decoder');
    const previous = process.env.AG_PROXY_FFMPEG_PATH;
    try {
      await writeFile(executable, '#!/usr/bin/python3\nimport signal,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\ntime.sleep(30)\n', { mode: 0o700 });
      process.env.AG_PROXY_FFMPEG_PATH = executable;
      const abort = new AbortController();
      const result = decodeSpeechAudio(wav(), abort.signal);
      const assertion = expect(result).rejects.toMatchObject({ status: 499 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const started = Date.now(); abort.abort();
      await assertion;
      expect(Date.now() - started).toBeLessThan(2500);
    } finally {
      if (previous === undefined) delete process.env.AG_PROXY_FFMPEG_PATH;
      else process.env.AG_PROXY_FFMPEG_PATH = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('aligns PCM samples across odd network chunks and rejects incomplete samples', async () => {
    const out = [];
    for await (const data of boundedLivePcm((async function* () { yield Buffer.from([1]); yield Buffer.from([2, 3, 4]); })())) out.push(data);
    expect(Buffer.concat(out)).toEqual(Buffer.from([1, 2, 3, 4]));
    const consume = async () => { for await (const data of boundedLivePcm((async function* () { yield Buffer.from([1]); })())) { expect(data.length).toBeGreaterThan(0); } };
    await expect(consume()).rejects.toMatchObject({ status: 400 });
  });
});
