import { isPlainObject, isString } from 'lodash-es';
import {
  type CompatibilityNotice,
  invalidRequest,
  POLICY_VERSION,
  unsupportedParameter,
} from './openai-request-normalizer-types';

export class OpenAIResponsesNormalizer {
  readonly policyVersion = POLICY_VERSION;

  /**
   * Normalizes incoming Responses API options (`/v1/responses`).
   */
  normalizeResponsesOptions(
    rawBody: Record<string, unknown>,
  ): { notices: readonly CompatibilityNotice[] } {
    const notices: CompatibilityNotice[] = [];

    // store
    if (Object.hasOwn(rawBody, 'store')) {
      const storeVal = rawBody.store;
      if (storeVal === false) {
        notices.push({
          parameter: 'store',
          ruleId: 'responses.store.stateless',
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
          ruleId: 'responses.store.omitted',
          action: 'accept-noop',
          reasonCode: 'store_null_accepted',
        });
      } else {
        throw invalidRequest('store must be a boolean', 'store');
      }
    }

    // background
    if (Object.hasOwn(rawBody, 'background')) {
      const bg = rawBody.background;
      if (bg === false || bg === null || bg === undefined) {
        notices.push({
          parameter: 'background',
          ruleId: 'responses.background.foreground',
          action: 'accept-noop',
          reasonCode: 'foreground_execution',
        });
      } else if (bg === true) {
        throw unsupportedParameter(
          'background',
          'background execution is not supported: asynchronous job lifecycle is not implemented',
        );
      } else {
        throw invalidRequest('background must be a boolean', 'background');
      }
    }

    // previous_response_id
    if (Object.hasOwn(rawBody, 'previous_response_id')) {
      const pri = rawBody.previous_response_id;
      if (pri === null || pri === undefined) {
        notices.push({
          parameter: 'previous_response_id',
          ruleId: 'responses.previous_response_id.none',
          action: 'accept-noop',
          reasonCode: 'no_prior_response',
        });
      } else {
        throw unsupportedParameter(
          'previous_response_id',
          'previous_response_id is not supported: persistent conversation context is not implemented',
        );
      }
    }

    // conversation
    if (Object.hasOwn(rawBody, 'conversation')) {
      const conv = rawBody.conversation;
      if (conv === null || conv === undefined) {
        notices.push({
          parameter: 'conversation',
          ruleId: 'responses.conversation.none',
          action: 'accept-noop',
          reasonCode: 'no_conversation_store',
        });
      } else {
        throw unsupportedParameter(
          'conversation',
          'conversation is not supported: persistent conversation store is not implemented',
        );
      }
    }

    // truncation
    if (Object.hasOwn(rawBody, 'truncation')) {
      const trunc = rawBody.truncation;
      if (trunc === 'disabled' || trunc === null || trunc === undefined) {
        notices.push({
          parameter: 'truncation',
          ruleId: 'responses.truncation.disabled',
          action: 'accept-noop',
          reasonCode: 'truncation_disabled',
        });
      } else {
        throw unsupportedParameter('truncation', 'custom truncation is not supported');
      }
    }

    // include
    if (Object.hasOwn(rawBody, 'include')) {
      const inc = rawBody.include;
      if (inc === null || inc === undefined || (Array.isArray(inc) && inc.length === 0)) {
        notices.push({
          parameter: 'include',
          ruleId: 'responses.include.empty',
          action: 'accept-noop',
          reasonCode: 'no_extra_artifacts_requested',
        });
      } else {
        throw unsupportedParameter(
          'include',
          'include is not supported: additional response artifacts are not available',
        );
      }
    }

    // parallel_tool_calls
    if (Object.hasOwn(rawBody, 'parallel_tool_calls')) {
      const ptc = rawBody.parallel_tool_calls;
      if (ptc === true || ptc === null || ptc === undefined) {
        notices.push({
          parameter: 'parallel_tool_calls',
          ruleId: 'responses.parallel_tool_calls.multi_permitted',
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

    // service_tier
    if (Object.hasOwn(rawBody, 'service_tier')) {
      const st = rawBody.service_tier;
      if (st === null || st === undefined || st === 'auto' || st === 'default') {
        notices.push({
          parameter: 'service_tier',
          ruleId: 'responses.service_tier.standard',
          action: 'accept-noop',
          reasonCode: 'standard_routing',
        });
      } else if (isString(st)) {
        throw unsupportedParameter('service_tier', `service_tier '${st}' is not supported`);
      } else {
        throw invalidRequest('service_tier must be a string', 'service_tier');
      }
    }

    // safety_identifier
    if (Object.hasOwn(rawBody, 'safety_identifier')) {
      const si = rawBody.safety_identifier;
      if (si === null || si === undefined) {
        notices.push({
          parameter: 'safety_identifier',
          ruleId: 'responses.safety_identifier.omitted',
          action: 'accept-noop',
          reasonCode: 'safety_identifier_omitted',
        });
      } else if (isString(si)) {
        if (si.length > 512) {
          throw invalidRequest('safety_identifier must not exceed 512 characters', 'safety_identifier');
        }
        notices.push({
          parameter: 'safety_identifier',
          ruleId: 'responses.safety_identifier.untrusted',
          action: 'ignore-with-notice',
          reasonCode: 'safety_identifier_not_forwarded',
        });
      } else {
        throw invalidRequest('safety_identifier must be a string', 'safety_identifier');
      }
    }

    // prompt_cache_key
    if (Object.hasOwn(rawBody, 'prompt_cache_key')) {
      const pck = rawBody.prompt_cache_key;
      if (pck === null || pck === undefined) {
        notices.push({
          parameter: 'prompt_cache_key',
          ruleId: 'responses.prompt_cache_key.omitted',
          action: 'accept-noop',
          reasonCode: 'prompt_cache_key_omitted',
        });
      } else if (isString(pck)) {
        if (pck.length > 512) {
          throw invalidRequest('prompt_cache_key must not exceed 512 characters', 'prompt_cache_key');
        }
        notices.push({
          parameter: 'prompt_cache_key',
          ruleId: 'responses.prompt_cache_key.untrusted',
          action: 'ignore-with-notice',
          reasonCode: 'prompt_cache_key_not_forwarded',
        });
      } else {
        throw invalidRequest('prompt_cache_key must be a string', 'prompt_cache_key');
      }
    }

    // prompt
    if (Object.hasOwn(rawBody, 'prompt')) {
      const p = rawBody.prompt;
      if (p !== null && p !== undefined) {
        throw unsupportedParameter('prompt', 'external prompt references are not supported');
      }
    }

    // prompt_cache_retention
    if (Object.hasOwn(rawBody, 'prompt_cache_retention')) {
      const pcr = rawBody.prompt_cache_retention;
      if (pcr !== null && pcr !== undefined) {
        throw unsupportedParameter(
          'prompt_cache_retention',
          'custom prompt cache retention is not supported',
        );
      }
    }

    // max_tool_calls
    if (Object.hasOwn(rawBody, 'max_tool_calls')) {
      const mtc = rawBody.max_tool_calls;
      if (mtc !== null && mtc !== undefined) {
        throw unsupportedParameter('max_tool_calls', 'max_tool_calls is not supported');
      }
    }

    // text
    if (Object.hasOwn(rawBody, 'text')) {
      const txt = rawBody.text;
      if (txt !== null && txt !== undefined) {
        if (!isPlainObject(txt)) {
          throw invalidRequest('text must be an object', 'text');
        }
        const textObj = txt as Record<string, unknown>;
        for (const key of Object.keys(textObj)) {
          if (key !== 'format') {
            throw unsupportedParameter(`text.${key}`, `text option '${key}' is not supported`);
          }
        }
        const fmt = textObj.format;
        if (fmt !== undefined && fmt !== null) {
          if (isPlainObject(fmt)) {
            const fmtObj = fmt as Record<string, unknown>;
            if (fmtObj.type !== 'text') {
              throw unsupportedParameter(
                'text.format.type',
                `format type '${String(fmtObj.type)}' is not supported; only 'text' is supported`,
              );
            }
          } else if (fmt !== 'text') {
            throw unsupportedParameter('text.format', `text format '${String(fmt)}' is not supported`);
          }
        }
        notices.push({
          parameter: 'text',
          ruleId: 'responses.text.default',
          action: 'accept-noop',
          reasonCode: 'default_text_format',
        });
      }
    }

    // metadata
    if (Object.hasOwn(rawBody, 'metadata')) {
      const meta = rawBody.metadata;
      if (meta === null || meta === undefined) {
        notices.push({
          parameter: 'metadata',
          ruleId: 'responses.metadata.omitted',
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
          ruleId: 'responses.metadata.unpersisted',
          action: 'ignore-with-notice',
          reasonCode: 'metadata_not_persisted',
        });
      } else {
        throw invalidRequest('metadata must be an object', 'metadata');
      }
    }

    // reasoning
    if (Object.hasOwn(rawBody, 'reasoning')) {
      const r = rawBody.reasoning;
      if (r !== null && r !== undefined) {
        throw unsupportedParameter(
          'reasoning',
          'custom reasoning configuration is not supported',
        );
      }
    }

    // top_logprobs
    if (Object.hasOwn(rawBody, 'top_logprobs')) {
      const tlp = rawBody.top_logprobs;
      if (tlp !== null && tlp !== undefined) {
        throw unsupportedParameter('top_logprobs', 'log probabilities are not available');
      }
    }

    return { notices };
  }
}
