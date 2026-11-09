import { BadRequestException } from '@nestjs/common';
import { OpenAIProtocolException } from './openai-protocol-error';

export function isPerformanceFailure(error: unknown): boolean {
  if (error instanceof BadRequestException || error instanceof OpenAIProtocolException) return false;
  if (error instanceof Error) {
    return error.name !== 'AbortError' && (error as { code?: unknown }).code !== 'ERR_CANCELED';
  }
  return false;
}
