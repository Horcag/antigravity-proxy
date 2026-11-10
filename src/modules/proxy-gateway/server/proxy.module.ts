import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { AccountLeaseService } from './account-lease.service';
import { GeminiClient } from './clients/gemini.client';
import { GeminiController } from './gemini.controller';
import { ProxyGuard } from './proxy.guard';
import { NativeSpeechController } from './speech/native-speech.controller';
import { NativeSpeechService } from './speech/native-speech.service';
import { NativeSpeechAuth } from './speech/native-speech-auth';
import {
  FastifyMultipartProvider,
  MultipartOpenAIExceptionFilter,
} from './fastify-multipart.provider';

@Module({
  imports: [],
  controllers: [ProxyController, GeminiController, NativeSpeechController],
  providers: [
    ProxyService,
    AccountLeaseService,
    GeminiClient,
    ProxyGuard,
    NativeSpeechService,
    NativeSpeechAuth,
    FastifyMultipartProvider,
    {
      provide: APP_FILTER,
      useClass: MultipartOpenAIExceptionFilter,
    },
  ],
  exports: [AccountLeaseService],
})
export class ProxyModule {}
