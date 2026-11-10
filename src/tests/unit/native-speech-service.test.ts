import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeSpeechService } from '../../modules/proxy-gateway/server/speech/native-speech.service';
import { NativeSpeechError } from '../../modules/proxy-gateway/server/speech/native-speech-client';
import type { NativeSpeechAuth } from '../../modules/proxy-gateway/server/speech/native-speech-auth';

const mocks = vi.hoisted(() => ({ transcribe: vi.fn(), decode: vi.fn() }));
vi.mock('../../modules/proxy-gateway/server/speech/native-speech-client', async (original) => ({
  ...await original<object>(), transcribeNativeSpeech: mocks.transcribe,
}));
vi.mock('../../modules/proxy-gateway/server/speech/native-speech-media', async (original) => ({
  ...await original<object>(), decodeSpeechAudio: mocks.decode,
}));
describe('NativeSpeechService result provenance', () => {
  const release = vi.fn();
  const auth = { resolve: vi.fn(), suspend: vi.fn() };
  const input = { timeoutMs: 3000, stream: false, file: Buffer.from('audio'), language: 'ru-RU', context: 'Only caller supplied context' };
  beforeEach(() => {
    vi.clearAllMocks();
    auth.resolve.mockResolvedValue({ accountId: 'selected', accessToken: 'private-token', models: ['models/native-test'], release });
    auth.suspend.mockResolvedValue(undefined);
    mocks.decode.mockResolvedValue(Buffer.alloc(3200));
  });
  const run = async () => {
    const events = [];
    for await (const event of new NativeSpeechService(auth as unknown as NativeSpeechAuth).transcribe(input, new AbortController().signal)) events.push(event);
    return events;
  };
  it('keeps actual draft snapshots separate from committed segments', async () => {
    mocks.transcribe.mockImplementation(async function* () {
      yield { type: 'ready', model: 'models/native-test' };
      yield { type: 'draft', text: 'first guess' };
      yield { type: 'final', text: 'First sentence.' };
      yield { type: 'draft', text: 'second guess' };
      yield { type: 'final', text: 'Second sentence.' };
      yield { type: 'complete', finalReceived: true };
    });
    const events = await run();
    expect(events.at(-1)).toMatchObject({ type: 'completed', result: {
      draft_text: 'First sentence. second guess', final_text: 'First sentence. Second sentence.',
      text: 'First sentence. Second sentence.', completed: true, draft_received: true, final_received: true,
      source: 'antigravity-native-stt', model: 'models/native-test',
    } });
    expect(mocks.transcribe.mock.calls[0][1]).toMatchObject({ language: 'ru-RU', context: input.context });
  });
  it('returns an incomplete draft without manufacturing final on timeout', async () => {
    mocks.transcribe.mockImplementation(async function* () {
      yield { type: 'draft', text: 'unfinished words' };
      throw new NativeSpeechError('timeout', 'Speech timed out', 504);
    });
    expect((await run()).at(-1)).toMatchObject({ result: {
      draft_text: 'unfinished words', final_text: null, text: null, completed: false, final_received: false,
      error: { code: 'timeout' },
    } });
    expect(auth.suspend).not.toHaveBeenCalled();
  });
  it('retains confirmed partial text while marking completion failure', async () => {
    mocks.transcribe.mockImplementation(async function* () {
      yield { type: 'final', text: 'Confirmed part.' };
      throw new NativeSpeechError('transport_error', 'Connection lost');
    });
    expect((await run()).at(-1)).toMatchObject({ result: {
      final_text: 'Confirmed part.', draft_text: '', draft_received: false, final_received: true, completed: false,
    } });
  });
  it('suspends only the pinned credential on explicit ToS, with no retry', async () => {
    mocks.transcribe.mockReturnValue({ [Symbol.asyncIterator]: () => ({ next: async () => { throw new NativeSpeechError('tos_violation', 'Restricted', 403, 7); } }) });
    await expect(run()).rejects.toMatchObject({ status: 403 });
    expect(auth.suspend).toHaveBeenCalledExactlyOnceWith('selected');
    expect(auth.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('preserves scope errors without suspending or falling back', async () => {
    mocks.transcribe.mockReturnValue({ [Symbol.asyncIterator]: () => ({ next: async () => { throw new NativeSpeechError('upstream_grpc_error', 'Permission denied', 403, 7); } }) });
    await expect(run()).rejects.toMatchObject({ status: 403 });
    expect(auth.suspend).not.toHaveBeenCalled();
    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
  });
  it('classifies a deadline during authorization consistently', async () => {
    auth.resolve.mockImplementation(async (signal: AbortSignal) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('catalog aborted');
    });
    const events = async () => {
      for await (const event of new NativeSpeechService(auth as unknown as NativeSpeechAuth).transcribe({ ...input, timeoutMs: 20 }, new AbortController().signal)) expect(event).toBeDefined();
    };
    await expect(events()).rejects.toMatchObject({ status: 504 });
    expect(release).not.toHaveBeenCalled();
  });
  it('releases account reservation when audio decoding fails', async () => {
    mocks.decode.mockRejectedValue(new Error('invalid audio'));
    await expect(run()).rejects.toThrow('invalid audio');
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('does not treat empty upstream final events as confirmed text', async () => {
    mocks.transcribe.mockImplementation(async function* () {
      yield { type: 'draft', text: 'rough' };
      yield { type: 'final', text: '   ' };
      throw new NativeSpeechError('incomplete_transcription', 'No confirmed text');
    });
    expect((await run()).at(-1)).toMatchObject({ result: {
      final_text: null, final_received: false, completed: false, draft_text: 'rough',
    } });
  });
});
