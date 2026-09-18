import { HttpStatus } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { OpenAIProtocolException } from './openai-protocol-error';

export type CompatibilityAction =
  | 'honor-locally'
  | 'translate'
  | 'accept-noop'
  | 'ignore-with-notice'
  | 'degrade-explicitly';

export interface CompatibilityNotice {
  readonly parameter: string;
  readonly ruleId: string;
  readonly action: CompatibilityAction;
  readonly reasonCode: string;
}

export interface NormalizationResult<T> {
  readonly normalized: T;
  readonly notices: readonly CompatibilityNotice[];
  readonly policyVersion: string;
}

export function invalidRequest(
  message: string,
  param?: string,
  code?: string,
): OpenAIProtocolException {
  return new OpenAIProtocolException(message, HttpStatus.BAD_REQUEST, {
    param,
    code: code ?? 'invalid_request_error',
  });
}

export function unsupportedParameter(param: string, reason: string): OpenAIProtocolException {
  return new OpenAIProtocolException(
    `${param} is not supported by this gateway: ${reason}`,
    HttpStatus.BAD_REQUEST,
    { param, code: 'unsupported_parameter' },
  );
}

export const POLICY_VERSION = '2026-09-18.v1';

/**
 * Attaches compatibility headers to the Fastify response before commitment.
 * Limits header length and separates dropped advisory options from locally honored options.
 */
export function attachCompatibilityHeaders(
  res: FastifyReply | undefined,
  notices: readonly CompatibilityNotice[],
): void {
  if (!res || typeof (res as any).header !== 'function' || notices.length === 0) {
    return;
  }

  const dropped = notices
    .filter((n) => n.action === 'ignore-with-notice')
    .map((n) => n.parameter);
  if (dropped.length > 0) {
    const headerValue = [...new Set(dropped)].slice(0, 8).join(', ');
    res.header('x-ag-proxy-dropped-params', headerValue);
  }

  const honored = notices
    .filter((n) => n.action === 'honor-locally')
    .map((n) => n.parameter);
  if (honored.length > 0) {
    const headerValue = [...new Set(honored)].slice(0, 8).join(', ');
    res.header('x-ag-proxy-honored-locally', headerValue);
  }
}
