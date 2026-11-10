import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { NativeSpeechService } from '../../modules/proxy-gateway/server/speech/native-speech.service';
import { NativeSpeechAuth } from '../../modules/proxy-gateway/server/speech/native-speech-auth';
import { AccountLeaseService } from '../../modules/proxy-gateway/server/account-lease.service';

vi.mock('../../modules/proxy-gateway/server/speech/native-speech-catalog', () => ({
  fetchNativeSpeechModels: async () => ['models/native-test'],
}));
const releaseReservation = vi.fn();
const acquireAttemptLease = vi.fn(async () => ({
  account: { id: 'pool-account', token: { access_token: 'fixture-token' } }, releaseReservation,
}));
@Module({ providers: [NativeSpeechService, NativeSpeechAuth,
  { provide: AccountLeaseService, useValue: { acquireAttemptLease } },
] })
class SpeechWiringModule {}
describe('native speech production dependency wiring', () => {
  it('constructs real speech service/auth with explicit DI and releases the pool lease', async () => {
    const app = await NestFactory.createApplicationContext(SpeechWiringModule, { logger: false });
    try {
      expect(await app.get(NativeSpeechService).models(new AbortController().signal)).toEqual({
        models: ['models/native-test'], default_model: 'models/native-test', source: 'antigravity-native-stt',
      });
      expect(acquireAttemptLease).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(releaseReservation).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
});
