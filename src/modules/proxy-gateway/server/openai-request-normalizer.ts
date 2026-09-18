import { isNumber, isPlainObject, isString } from 'lodash-es';
import type { OpenAIChatRequest } from './interfaces/request-interfaces';
import {
  type CompatibilityAction,
  type CompatibilityNotice,
  invalidRequest,
  type NormalizationResult,
  POLICY_VERSION,
  unsupportedParameter,
  attachCompatibilityHeaders,
} from './openai-request-normalizer-types';
import { OpenAIResponsesNormalizer } from './openai-responses-normalizer';

export {
  type CompatibilityAction,
  type CompatibilityNotice,
  type NormalizationResult,
  invalidRequest,
  unsupportedParameter,
  attachCompatibilityHeaders,
};

export class OpenAIRequestNormalizer {
  readonly policyVersion = POLICY_VERSION;
  private readonly responsesNormalizer = new OpenAIResponsesNormalizer();

  /**
   * Normalizes an incoming Chat Completions request (`/v1/chat/completions`).
   * Implements value-aware, capability-aware normalization following Postel's Law:
   * accepts supported defaults, gateway-owned behaviors, and advisory client fields
   * without mutating the input object.
   */
  normalizeChatRequest(rawBody: unknown): NormalizationResult<OpenAIChatRequest> {
    if (!isPlainObject(rawBody)) {
      throw invalidRequest('request body must be a JSON object');
    }

    const body = rawBody as Record<string, unknown>;
    const notices: CompatibilityNotice[] = [];

    // 1. Model
    if (!isString(body.model) || body.model.trim().length === 0) {
      throw invalidRequest('model is required and must be a non-empty string', 'model');
    }

    // 2. Messages
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw invalidRequest('messages must be a non-empty array', 'messages');
    }

    // Build clean normalized request
    const normalized: OpenAIChatRequest = {
      model: body.model.trim(),
      messages: body.messages,
    };

    // 3. store (OpenAI distillation opt-out flag)
    if (Object.hasOwn(body, 'store')) {
      const storeVal = body.store;
      if (storeVal === false) {
        notices.push({
          parameter: 'store',
          ruleId: 'chat.store.stateless',
          action: 'honor-locally',
          reasonCode: 'stateless_proxy_retention',
        });
      } else if (storeVal === true) {
        throw unsupportedParameter(
          'store',
          'persistent response storage is not implemented',
        );
      } else if (storeVal === null || storeVal === undefined) {
        notices.push({
          parameter: 'store',
          ruleId: 'chat.store.omitted',
          action: 'accept-noop',
          reasonCode: 'store_null_accepted',
        });
      } else {
        throw invalidRequest('store must be a boolean', 'store');
      }
    }

    // 4. parallel_tool_calls
    if (Object.hasOwn(body, 'parallel_tool_calls')) {
      const ptc = body.parallel_tool_calls;
      if (ptc === true || ptc === null || ptc === undefined) {
        notices.push({
          parameter: 'parallel_tool_calls',
          ruleId: 'chat.parallel_tool_calls.multi_permitted',
          action: 'accept-noop',
          reasonCode: 'multi_tool_calls_permitted',
        });
      } else if (ptc === false) {
        throw unsupportedParameter(
          'parallel_tool_calls',
          'single-tool execution cannot be enforced upstream',
        );
      } else {
        throw invalidRequest('parallel_tool_calls must be a boolean', 'parallel_tool_calls');
      }
    }

    // 5. service_tier
    if (Object.hasOwn(body, 'service_tier')) {
      const st = body.service_tier;
      if (st === null || st === undefined || st === 'auto' || st === 'default') {
        notices.push({
          parameter: 'service_tier',
          ruleId: 'chat.service_tier.standard',
          action: 'accept-noop',
          reasonCode: 'standard_routing',
        });
      } else if (isString(st)) {
        throw unsupportedParameter('service_tier', `service_tier '${st}' is not supported`);
      } else {
        throw invalidRequest('service_tier must be a string', 'service_tier');
      }
    }

    // 6. user (advisory client tracking identifier)
    if (Object.hasOwn(body, 'user')) {
      const u = body.user;
      if (u === null || u === undefined) {
        notices.push({
          parameter: 'user',
          ruleId: 'chat.user.omitted',
          action: 'accept-noop',
          reasonCode: 'user_omitted',
        });
      } else if (isString(u)) {
        if (u.length > 512) {
          throw invalidRequest('user must not exceed 512 characters', 'user');
        }
        notices.push({
          parameter: 'user',
          ruleId: 'chat.user.untrusted_identifier',
          action: 'ignore-with-notice',
          reasonCode: 'user_attribution_not_forwarded',
        });
      } else {
        throw invalidRequest('user must be a string', 'user');
      }
    }

    // 7. metadata (client-side KV tags)
    if (Object.hasOwn(body, 'metadata')) {
      const meta = body.metadata;
      if (meta === null || meta === undefined) {
        notices.push({
          parameter: 'metadata',
          ruleId: 'chat.metadata.omitted',
          action: 'accept-noop',
          reasonCode: 'metadata_omitted',
        });
      } else if (isPlainObject(meta)) {
        const keys = Object.keys(meta as object);
        if (keys.length > 16) {
          throw invalidRequest('metadata supports at most 16 entries', 'metadata');
        }
        for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
          if (k.length > 64) throw invalidRequest('metadata key length exceeds 64 characters', `metadata.${k}`);
          if (!isString(v)) throw invalidRequest('metadata must be an object with string values', `metadata.${k}`);
          if (v.length > 512) throw invalidRequest('metadata value length exceeds 512 characters', `metadata.${k}`);
        }
        notices.push({
          parameter: 'metadata',
          ruleId: 'chat.metadata.unpersisted',
          action: 'ignore-with-notice',
          reasonCode: 'metadata_not_persisted',
        });
      } else {
        throw invalidRequest('metadata must be an object', 'metadata');
      }
    }

    // 8. modalities
    if (Object.hasOwn(body, 'modalities')) {
      const modalities = body.modalities;
      if (modalities === null || modalities === undefined) {
        notices.push({
          parameter: 'modalities',
          ruleId: 'chat.modalities.omitted',
          action: 'accept-noop',
          reasonCode: 'modalities_omitted',
        });
      } else if (Array.isArray(modalities)) {
        const isTextOnly = modalities.length === 1 && modalities[0] === 'text';
        if (isTextOnly) {
          notices.push({
            parameter: 'modalities',
            ruleId: 'chat.modalities.text_only',
            action: 'accept-noop',
            reasonCode: 'text_modality_supported',
          });
        } else {
          throw unsupportedParameter(
            'modalities',
            `unsupported modalities: ${JSON.stringify(modalities)}. Only ['text'] is supported`,
          );
        }
      } else {
        throw invalidRequest('modalities must be an array', 'modalities');
      }
    }

    // 9. prediction (speculative decoding)
    if (Object.hasOwn(body, 'prediction')) {
      const pred = body.prediction;
      if (pred !== null && pred !== undefined) {
        throw unsupportedParameter(
          'prediction',
          'speculative decoding (prediction) is not supported',
        );
      }
    }

    // 10. seed (forwarded upstream to Gemini generationConfig.seed)
    if (Object.hasOwn(body, 'seed')) {
      const seedVal = body.seed;
      if (seedVal === null || seedVal === undefined) {
        notices.push({
          parameter: 'seed',
          ruleId: 'chat.seed.omitted',
          action: 'accept-noop',
          reasonCode: 'seed_omitted',
        });
      } else if (isNumber(seedVal) && Number.isInteger(seedVal) && seedVal >= -2147483648 && seedVal <= 2147483647) {
        normalized.seed = seedVal;
        notices.push({
          parameter: 'seed',
          ruleId: 'chat.seed.translated',
          action: 'translate',
          reasonCode: 'seed_forwarded',
        });
      } else {
        throw invalidRequest('seed must be an integer between -2147483648 and 2147483647', 'seed');
      }
    }

    // 11. presence_penalty & frequency_penalty
    for (const param of ['presence_penalty', 'frequency_penalty'] as const) {
      if (Object.hasOwn(body, param)) {
        const val = body[param];
        if (val === null || val === undefined || val === 0) {
          notices.push({
            parameter: param,
            ruleId: `chat.${param}.zero`,
            action: 'accept-noop',
            reasonCode: 'penalty_zero_accepted',
          });
        } else if (isNumber(val) && Number.isFinite(val)) {
          throw unsupportedParameter(param, 'only the default value 0 is supported');
        } else {
          throw invalidRequest(`${param} must be a number`, param);
        }
      }
    }

    // 12. logit_bias
    if (Object.hasOwn(body, 'logit_bias')) {
      const lb = body.logit_bias;
      if (lb !== null && lb !== undefined) {
        if (!isPlainObject(lb)) {
          throw invalidRequest('logit_bias must be an object', 'logit_bias');
        }
        if (Object.keys(lb as object).length === 0) {
          notices.push({
            parameter: 'logit_bias',
            ruleId: 'chat.logit_bias.empty',
            action: 'accept-noop',
            reasonCode: 'empty_bias_accepted',
          });
        } else {
          throw unsupportedParameter('logit_bias', 'token biasing is not supported');
        }
      }
    }

    // 13. n (candidate count)
    if (Object.hasOwn(body, 'n')) {
      const nVal = body.n;
      if (nVal === null || nVal === undefined || nVal === 1) {
        normalized.n = 1;
        notices.push({
          parameter: 'n',
          ruleId: 'chat.n.single',
          action: 'accept-noop',
          reasonCode: 'single_candidate_accepted',
        });
      } else if (isNumber(nVal) && Number.isInteger(nVal)) {
        throw unsupportedParameter('n', 'only n=1 is supported');
      } else {
        throw invalidRequest('n must be an integer', 'n');
      }
    }

    // 14. logprobs & top_logprobs
    if (Object.hasOwn(body, 'logprobs')) {
      const lp = body.logprobs;
      if (lp !== null && lp !== undefined && lp !== false) {
        throw unsupportedParameter('logprobs', 'log probabilities are not available');
      }
    }
    if (Object.hasOwn(body, 'top_logprobs')) {
      const tlp = body.top_logprobs;
      if (tlp !== null && tlp !== undefined) {
        throw unsupportedParameter('top_logprobs', 'log probabilities are not available');
      }
    }

    // 15. Pass-through generation parameters
    if (body.temperature !== undefined) normalized.temperature = body.temperature as number;
    if (body.top_p !== undefined) normalized.top_p = body.top_p as number;
    if (body.max_tokens !== undefined) normalized.max_tokens = body.max_tokens as number;
    if (body.max_completion_tokens !== undefined) {
      normalized.max_completion_tokens = body.max_completion_tokens as number;
    }
    if (body.stream !== undefined) normalized.stream = body.stream as boolean;
    if (body.stream_options !== undefined) {
      normalized.stream_options = body.stream_options as OpenAIChatRequest['stream_options'];
      if (normalized.stream_options?.include_usage) {
        notices.push({
          parameter: 'stream_options.include_usage',
          ruleId: 'chat.stream_options.usage',
          action: 'honor-locally',
          reasonCode: 'stream_usage_emitted_locally',
        });
      }
    }
    if (body.stop !== undefined) normalized.stop = body.stop as string | string[];
    if (body.tools !== undefined) normalized.tools = body.tools as OpenAIChatRequest['tools'];
    if (body.tool_choice !== undefined) {
      normalized.tool_choice = body.tool_choice as OpenAIChatRequest['tool_choice'];
    }
    if (body.response_format !== undefined) {
      normalized.response_format = body.response_format as OpenAIChatRequest['response_format'];
    }
    if (body.extra !== undefined) {
      if (body.extra !== null && !isPlainObject(body.extra)) {
        throw invalidRequest('extra must be an object', 'extra');
      }
      if (body.extra !== null) {
        normalized.extra = body.extra as Record<string, unknown>;
        notices.push({
          parameter: 'extra',
          ruleId: 'chat.extra.session_context',
          action: 'honor-locally',
          reasonCode: 'session_context_preserved',
        });
      }
    }

    return {
      normalized,
      notices,
      policyVersion: this.policyVersion,
    };
  }

  /**
   * Normalizes incoming Responses API options (`/v1/responses`).
   */
  normalizeResponsesOptions(
    rawBody: Record<string, unknown>,
  ): { notices: readonly CompatibilityNotice[] } {
    return this.responsesNormalizer.normalizeResponsesOptions(rawBody);
  }
}
