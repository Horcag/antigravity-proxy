import { describe, expect, it } from 'vitest';
import { transcriptionResidual } from '../../modules/proxy-gateway/server/speech/native-speech-residual';
import {
  activityMessage, audioEndMessage, audioMessage, boolField, bytesField, contextMessage,
  decodeSpeechResponse, GrpcFrameDecoder, grpcFrame, setupMessage, textField,
} from '../../modules/proxy-gateway/server/speech/native-speech-protocol';

describe('native speech wire protocol', () => {
  it('encodes proven setup, manual activity, audio and language fields', () => {
    expect(setupMessage('m', 'ru-RU').toString('hex')).toBe('0a140a016d2a043202080142091a070a0572752d5255');
    expect(activityMessage(true).toString('hex')).toBe('1a022a00');
    expect(activityMessage(false).toString('hex')).toBe('1a023200');
    expect(audioEndMessage().toString('hex')).toBe('1a021001');
    expect(audioMessage(Buffer.from([1, 2]))).toEqual(bytesField(3, bytesField(1, Buffer.concat([
      textField(1, 'audio/pcm;rate=16000'), bytesField(2, Buffer.from([1, 2])),
    ]))));
  });
  it('encodes context as AsrContext NAM REPLACE with Content and Part messages', () => {
    expect(contextMessage('test')).toEqual(bytesField(6, bytesField(5, Buffer.concat([
      Buffer.from([8, 2, 16, 2]), bytesField(3, bytesField(2, textField(1, 'test'))),
    ]))));
    expect(contextMessage(undefined, ['A', 'B'])).toEqual(contextMessage('Vocabulary: A, B'));
    expect(contextMessage()).toBeUndefined();
  });
  it('decodes distinct confirmed and undecided transcription and skips unknown fields', () => {
    const response = Buffer.concat([
      bytesField(1, Buffer.alloc(0)), boolField(99),
      bytesField(2, Buffer.concat([
        bytesField(11, textField(1, 'draft')),
        bytesField(6, Buffer.concat([textField(1, 'final'), boolField(2)])), boolField(3),
      ])),
    ]);
    expect(decodeSpeechResponse(response)).toEqual({ setupComplete: true, turnComplete: true, transcripts: [
      { kind: 'draft', text: 'draft', finished: false }, { kind: 'final', text: 'final', finished: true },
    ] });
  });
  it('matches native ASR residual rules across rewritten punctuation and Unicode', () => {
    expect(transcriptionResidual('Well, HELLO world! More', 'hello, world.')).toBe('More');
    expect(transcriptionResidual('Привет, МИР! Дальше', 'привет мир')).toBe('Дальше');
    expect(transcriptionResidual('😀 Hello! 😀 Next', 'hello')).toBe('😀 Next');
    expect(transcriptionResidual('word word next', 'word')).toBe('word next');
    expect(transcriptionResidual('rewritten pending', 'new final')).toBe('');
    expect(transcriptionResidual('pending', '!?')).toBe('');
  });
  it('handles every frame boundary and multiple frames', () => {
    const message = textField(1, 'fragment');
    const frame = grpcFrame(message);
    for (let i = 0; i < frame.length; i++) {
      const decoder = new GrpcFrameDecoder();
      expect([...decoder.push(frame.subarray(0, i)), ...decoder.push(frame.subarray(i))]).toEqual([message]);
      expect(() => decoder.finish()).not.toThrow();
    }
    expect(new GrpcFrameDecoder().push(Buffer.concat([frame, frame]))).toEqual([message, message]);
  });
  it('rejects truncated, compressed, oversized and invalid protobuf payloads', () => {
    const decoder = new GrpcFrameDecoder();
    decoder.push(Buffer.from([0, 0]));
    expect(() => decoder.finish()).toThrow('Truncated');
    expect(() => new GrpcFrameDecoder().push(Buffer.from([1, 0, 0, 0, 0]))).toThrow('Compressed');
    expect(() => new GrpcFrameDecoder().push(Buffer.from([0, 0, 64, 0, 1]))).toThrow('Oversized');
    for (const bytes of [[18, 4, 1], [128], [0], [19], [18, 1, 128]]) {
      expect(() => decodeSpeechResponse(Buffer.from(bytes))).toThrow();
    }
  });
});
