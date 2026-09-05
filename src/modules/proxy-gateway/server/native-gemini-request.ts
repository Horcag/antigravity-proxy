import { BadRequestException } from '@nestjs/common';
import { isEmpty, isEqual, isPlainObject, isString } from 'lodash-es';

import type { GeminiInternalRequest, GeminiToolDeclaration } from '../antigravity/types';

type NativeGeminiRequest = GeminiInternalRequest['request'];
type UnknownRecord = Record<string, unknown>;

const FUNCTION_DECLARATION_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const FUNCTION_CALL_RESPONSE_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const FUNCTION_RESPONSE_SCHEDULING = new Set(['WHEN_IDLE', 'SILENT', 'INTERRUPT']);
const CODE_EXECUTION_OUTCOMES = new Set([
  'OUTCOME_OK',
  'OUTCOME_FAILED',
  'OUTCOME_DEADLINE_EXCEEDED',
]);
const PART_DATA_FIELDS = [
  'text',
  'inlineData',
  'fileData',
  'functionCall',
  'functionResponse',
  'executableCode',
  'codeExecutionResult',
  'toolCall',
  'toolResponse',
] as const;
const PART_METADATA_FIELDS = [
  'thought',
  'thoughtSignature',
  'thought_signature',
  'partMetadata',
  'mediaResolution',
  'mediaProcessing',
  'videoMetadata',
] as const;
const KNOWN_PART_FIELDS = new Set<string>([...PART_DATA_FIELDS, ...PART_METADATA_FIELDS]);

/**
 * Validates and normalizes native Gemini request data without selecting accounts, refreshing
 * quota, or touching signature state. Controllers and direct service callers share this boundary.
 */
export function preflightNativeGeminiRequest(request: unknown): NativeGeminiRequest {
  const nativeRequest = toRecord(request);
  if (!nativeRequest) {
    throw new BadRequestException('request must be an object');
  }

  const normalizedRequest = { ...nativeRequest };
  delete normalizedRequest.tool_config;
  return {
    ...normalizedRequest,
    contents: normalizeContents(nativeRequest.contents),
    ...(nativeRequest.systemInstruction !== undefined
      ? { systemInstruction: normalizeSystemInstruction(nativeRequest.systemInstruction) }
      : {}),
    ...(nativeRequest.toolConfig !== undefined || nativeRequest.tool_config !== undefined
      ? { toolConfig: normalizeToolConfig(nativeRequest) }
      : {}),
    ...(nativeRequest.tools !== undefined ? { tools: normalizeTools(nativeRequest.tools) } : {}),
  } as NativeGeminiRequest;
}

function normalizeToolConfig(request: UnknownRecord): NativeGeminiRequest['toolConfig'] {
  const camelCase = request.toolConfig;
  const snakeCase = request.tool_config;
  const normalizedCamelCase = validateToolConfig(camelCase, 'toolConfig');
  const normalizedSnakeCase = validateToolConfig(snakeCase, 'tool_config');
  if (camelCase !== undefined && snakeCase !== undefined && !isEqual(camelCase, snakeCase)) {
    throw new BadRequestException('toolConfig and tool_config must not contradict each other');
  }
  return normalizedCamelCase ?? normalizedSnakeCase;
}

function validateToolConfig(
  value: unknown,
  fieldName: 'toolConfig' | 'tool_config',
): NativeGeminiRequest['toolConfig'] {
  if (value === undefined) {
    return undefined;
  }
  const toolConfig = toRecord(value);
  if (
    !toolConfig ||
    !Object.hasOwn(toolConfig, 'functionCallingConfig')
  ) {
    throw new BadRequestException(`${fieldName} must contain functionCallingConfig`);
  }

  const functionCallingConfig = toRecord(toolConfig.functionCallingConfig);
  if (
    !functionCallingConfig ||
    !Object.hasOwn(functionCallingConfig, 'mode')
  ) {
    throw new BadRequestException(
      `${fieldName}.functionCallingConfig must contain mode`,
    );
  }

  const mode = functionCallingConfig.mode;
  if (
    mode !== 'VALIDATED' &&
    mode !== 'NONE' &&
    mode !== 'AUTO' &&
    mode !== 'ANY'
  ) {
    throw new BadRequestException(
      `${fieldName}.functionCallingConfig.mode must be AUTO, ANY, NONE, or VALIDATED`,
    );
  }
  let allowedFunctionNames: string[] | undefined;
  if (Object.hasOwn(functionCallingConfig, 'allowedFunctionNames')) {
    const names = functionCallingConfig.allowedFunctionNames;
    if (
      (mode !== 'ANY' && mode !== 'VALIDATED') ||
      !Array.isArray(names)
    ) {
      throw new BadRequestException(
        `${fieldName}.functionCallingConfig.allowedFunctionNames must be a string array for ANY or VALIDATED mode`,
      );
    }
    allowedFunctionNames = names.map((name, index) =>
      validateFunctionDeclarationName(
        name,
        `${fieldName}.functionCallingConfig.allowedFunctionNames[${index}]`,
      ),
    );
  }

  return {
    ...toolConfig,
    functionCallingConfig: {
      ...functionCallingConfig,
      mode,
      ...(allowedFunctionNames !== undefined ? { allowedFunctionNames } : {}),
    },
  };
}

function normalizeTools(value: unknown): NativeGeminiRequest['tools'] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new BadRequestException('tools must be an array');
  }

  return value.map((tool, toolIndex) => {
    const toolRecord = toRecord(tool);
    if (!toolRecord) {
      throw new BadRequestException(`tools[${toolIndex}] must be an object`);
    }

    if (!Object.hasOwn(toolRecord, 'functionDeclarations')) {
      return toolRecord as GeminiToolDeclaration;
    }

    const functionDeclarations = toolRecord.functionDeclarations;
    if (!Array.isArray(functionDeclarations)) {
      throw new BadRequestException(`tools[${toolIndex}].functionDeclarations must be an array`);
    }

    return {
      ...toolRecord,
      functionDeclarations: functionDeclarations.map((declaration, declarationIndex) => {
        const functionDeclaration = toRecord(declaration);
        const location = `tools[${toolIndex}].functionDeclarations[${declarationIndex}]`;
        if (!functionDeclaration) {
          throw new BadRequestException(`${location} must be an object`);
        }

        return {
          ...functionDeclaration,
          name: validateFunctionDeclarationName(functionDeclaration.name, `${location}.name`),
        };
      }),
    } as GeminiToolDeclaration;
  });
}

function normalizeContents(contents: unknown): NativeGeminiRequest['contents'] {
  if (!Array.isArray(contents) || contents.length === 0) {
    throw new BadRequestException('contents must be a non-empty array');
  }

  return contents.map((content, contentIndex) => {
    const contentRecord = toRecord(content);
    if (
      !contentRecord ||
      !Object.hasOwn(contentRecord, 'parts') ||
      !Array.isArray(contentRecord.parts) ||
      contentRecord.parts.length === 0
    ) {
      throw new BadRequestException(`contents[${contentIndex}] must contain a non-empty parts array`);
    }
    if (
      Object.hasOwn(contentRecord, 'role') &&
      (!isString(contentRecord.role) || (contentRecord.role !== 'user' && contentRecord.role !== 'model'))
    ) {
      throw new BadRequestException(`contents[${contentIndex}].role must be user or model`);
    }

    return {
      ...contentRecord,
      parts: contentRecord.parts.map((part, partIndex) =>
        normalizePart(part, `contents[${contentIndex}].parts[${partIndex}]`),
      ),
    };
  }) as NativeGeminiRequest['contents'];
}

function normalizeSystemInstruction(value: unknown): NativeGeminiRequest['systemInstruction'] {
  if (value === undefined) {
    return undefined;
  }
  const instruction = toRecord(value);
  if (
    !instruction ||
    !Object.hasOwn(instruction, 'parts') ||
    !Array.isArray(instruction.parts) ||
    instruction.parts.length === 0
  ) {
    throw new BadRequestException('systemInstruction must contain a non-empty parts array');
  }

  return {
    ...instruction,
    parts: instruction.parts.map((part, index) => {
      const partRecord = toRecord(part);
      const location = `systemInstruction.parts[${index}]`;
      if (!partRecord || !Object.hasOwn(partRecord, 'text')) {
        throw new BadRequestException(`${location}.text must be a non-empty string`);
      }
      requireNonEmptyString(partRecord.text, `${location}.text`);
      return normalizePart(part, location);
    }),
  };
}

function normalizePart(value: unknown, location: string): UnknownRecord {
  const part = toRecord(value);
  if (!part) {
    throw new BadRequestException(`${location} must be an object`);
  }

  const normalizedPart: UnknownRecord = { ...part };
  normalizeThoughtSignature(normalizedPart, location);
  validateScalarPartFields(normalizedPart, location);
  validatePartDataShape(normalizedPart, location);

  if (Object.hasOwn(part, 'functionCall')) {
    normalizedPart.functionCall = normalizeFunctionCall(part.functionCall, `${location}.functionCall`);
  }
  if (Object.hasOwn(part, 'functionResponse')) {
    normalizedPart.functionResponse = normalizeFunctionResponse(
      part.functionResponse,
      `${location}.functionResponse`,
    );
  }
  if (Object.hasOwn(part, 'fileData')) {
    validateFileData(part.fileData, `${location}.fileData`);
  }
  if (Object.hasOwn(part, 'executableCode')) {
    validateExecutableCode(part.executableCode, `${location}.executableCode`);
  }
  if (Object.hasOwn(part, 'codeExecutionResult')) {
    validateCodeExecutionResult(part.codeExecutionResult, `${location}.codeExecutionResult`);
  }
  for (const fieldName of ['toolCall', 'toolResponse'] as const) {
    if (Object.hasOwn(part, fieldName) && !toRecord(part[fieldName])) {
      throw new BadRequestException(`${location}.${fieldName} must be an object`);
    }
  }

  return normalizedPart;
}

function validateScalarPartFields(part: UnknownRecord, location: string): void {
  if (Object.hasOwn(part, 'text')) {
    requireNonEmptyString(part.text, `${location}.text`);
  }
  if (Object.hasOwn(part, 'thought') && typeof part.thought !== 'boolean') {
    throw new BadRequestException(`${location}.thought must be a boolean`);
  }
  if (Object.hasOwn(part, 'inlineData')) {
    validateInlineData(part.inlineData, `${location}.inlineData`);
  }
}

function validatePartDataShape(part: UnknownRecord, location: string): void {
  const knownDataFieldCount = PART_DATA_FIELDS.filter((fieldName) => Object.hasOwn(part, fieldName)).length;
  const opaqueDataFieldCount = getOpaquePartDataFields(part).length;
  if (
    knownDataFieldCount > 1 ||
    opaqueDataFieldCount > 1 ||
    (knownDataFieldCount > 0 && opaqueDataFieldCount > 0)
  ) {
    throw new BadRequestException(`${location} must contain at most one data field`);
  }
  if (knownDataFieldCount === 0 && opaqueDataFieldCount !== 1) {
    throw new BadRequestException(
      `${location} must contain one data field or be an opaque extension-only part`,
    );
  }
}

function getOpaquePartDataFields(part: UnknownRecord): string[] {
  // Unknown fields are data variants unless their name explicitly declares metadata passthrough.
  return Object.keys(part).filter(
    (fieldName) => !KNOWN_PART_FIELDS.has(fieldName) && !isMetadataExtensionField(fieldName),
  );
}

function isMetadataExtensionField(fieldName: string): boolean {
  return fieldName.endsWith('Extension');
}

function validateInlineData(value: unknown, location: string): void {
  const inlineData = toRecord(value);
  if (!inlineData || !Object.hasOwn(inlineData, 'mimeType') || !Object.hasOwn(inlineData, 'data')) {
    throw new BadRequestException(`${location} must contain non-empty string mimeType and data`);
  }
  requireNonEmptyString(inlineData.mimeType, `${location}.mimeType`);
  requireNonEmptyString(inlineData.data, `${location}.data`);
}

function validateFileData(value: unknown, location: string): void {
  const fileData = toRecord(value);
  if (!fileData || !Object.hasOwn(fileData, 'fileUri')) {
    throw new BadRequestException(`${location} must contain a non-empty string fileUri`);
  }
  requireNonEmptyString(fileData.fileUri, `${location}.fileUri`);
  if (Object.hasOwn(fileData, 'mimeType')) {
    requireNonEmptyString(fileData.mimeType, `${location}.mimeType`);
  }
}

function validateExecutableCode(value: unknown, location: string): void {
  const executableCode = toRecord(value);
  if (!executableCode) {
    throw new BadRequestException(`${location} must be an object`);
  }
  if (executableCode.language !== 'PYTHON') {
    throw new BadRequestException(`${location}.language must be PYTHON`);
  }
  requireNonEmptyString(executableCode.code, `${location}.code`);
  validateOptionalIdentifier(executableCode, location);
}

function validateCodeExecutionResult(value: unknown, location: string): void {
  const codeExecutionResult = toRecord(value);
  if (
    !codeExecutionResult ||
    !isString(codeExecutionResult.outcome) ||
    !CODE_EXECUTION_OUTCOMES.has(codeExecutionResult.outcome)
  ) {
    throw new BadRequestException(
      `${location}.outcome must be OUTCOME_OK, OUTCOME_FAILED, or OUTCOME_DEADLINE_EXCEEDED`,
    );
  }
  if (Object.hasOwn(codeExecutionResult, 'output') && !isString(codeExecutionResult.output)) {
    throw new BadRequestException(`${location}.output must be a string`);
  }
  validateOptionalIdentifier(codeExecutionResult, location);
}

function normalizeFunctionCall(value: unknown, location: string): UnknownRecord {
  const functionCall = toRecord(value);
  if (!functionCall) {
    throw new BadRequestException(`${location} must be an object`);
  }
  const name = validateFunctionCallOrResponseName(functionCall.name, `${location}.name`);

  const id = Object.hasOwn(functionCall, 'id') && isString(functionCall.id)
    ? functionCall.id.trim()
    : '';
  if (Object.hasOwn(functionCall, 'id') && !id) {
    throw new BadRequestException(`${location}.id must be a non-empty string`);
  }

  const args = Object.hasOwn(functionCall, 'args') ? toRecord(functionCall.args) : {};
  if (!args) {
    throw new BadRequestException(`${location}.args must be a plain JSON object`);
  }

  return { ...functionCall, name, args, ...(id ? { id } : {}) };
}

function normalizeFunctionResponse(value: unknown, location: string): UnknownRecord {
  const functionResponse = toRecord(value);
  if (!functionResponse) {
    throw new BadRequestException(`${location} must be an object`);
  }
  const name = validateFunctionCallOrResponseName(functionResponse.name, `${location}.name`);
  const response = Object.hasOwn(functionResponse, 'response')
    ? toRecord(functionResponse.response)
    : null;
  if (!response) {
    throw new BadRequestException(`${location}.response must be a plain JSON object`);
  }

  const id = Object.hasOwn(functionResponse, 'id') && isString(functionResponse.id)
    ? functionResponse.id.trim()
    : '';
  if (Object.hasOwn(functionResponse, 'id') && !id) {
    throw new BadRequestException(`${location}.id must be a non-empty string`);
  }
  if (Object.hasOwn(functionResponse, 'willContinue') && typeof functionResponse.willContinue !== 'boolean') {
    throw new BadRequestException(`${location}.willContinue must be a boolean`);
  }
  if (
    Object.hasOwn(functionResponse, 'scheduling') &&
    (!isString(functionResponse.scheduling) || !FUNCTION_RESPONSE_SCHEDULING.has(functionResponse.scheduling))
  ) {
    throw new BadRequestException(
      `${location}.scheduling must be WHEN_IDLE, SILENT, or INTERRUPT`,
    );
  }

  let parts: UnknownRecord[] | undefined;
  if (Object.hasOwn(functionResponse, 'parts')) {
    if (!Array.isArray(functionResponse.parts) || functionResponse.parts.length === 0) {
      throw new BadRequestException(`${location}.parts must be a non-empty array`);
    }
    parts = functionResponse.parts.map((part, index) =>
      normalizeFunctionResponsePart(part, `${location}.parts[${index}]`),
    );
  }

  return {
    ...functionResponse,
    name,
    response,
    ...(id ? { id } : {}),
    ...(parts !== undefined ? { parts } : {}),
  };
}

function normalizeFunctionResponsePart(value: unknown, location: string): UnknownRecord {
  const part = toRecord(value);
  if (!part) {
    throw new BadRequestException(`${location} must contain inlineData`);
  }
  normalizeThoughtSignature(part, location);
  validateScalarPartFields(part, location);
  if (getOpaquePartDataFields(part).length > 0) {
    throw new BadRequestException(`${location} may only contain inlineData data`);
  }
  if (!Object.hasOwn(part, 'inlineData')) {
    throw new BadRequestException(`${location} must contain inlineData`);
  }
  for (const fieldName of PART_DATA_FIELDS) {
    if (fieldName !== 'inlineData' && Object.hasOwn(part, fieldName)) {
      throw new BadRequestException(`${location} may only contain inlineData data`);
    }
  }
  return { ...part };
}

function normalizeThoughtSignature(part: UnknownRecord, location: string): void {
  const camelCase = part.thoughtSignature;
  const snakeCase = part.thought_signature;
  if (camelCase !== undefined && (!isString(camelCase) || isEmpty(camelCase.trim()))) {
    throw new BadRequestException(`${location}.thoughtSignature must be a non-empty string`);
  }
  if (snakeCase !== undefined && (!isString(snakeCase) || isEmpty(snakeCase.trim()))) {
    throw new BadRequestException(`${location}.thought_signature must be a non-empty string`);
  }
  if (camelCase !== undefined && snakeCase !== undefined && camelCase !== snakeCase) {
    throw new BadRequestException(`${location}.thoughtSignature and thought_signature must match`);
  }
}

function validateFunctionDeclarationName(value: unknown, location: string): string {
  if (!isString(value) || !FUNCTION_DECLARATION_NAME.test(value)) {
    throw new BadRequestException(
      `${location} must use only letters, digits, underscores, dots, colons, or dashes, and be at most 128 characters`,
    );
  }
  return value;
}

function validateFunctionCallOrResponseName(value: unknown, location: string): string {
  if (!isString(value) || !FUNCTION_CALL_RESPONSE_NAME.test(value)) {
    throw new BadRequestException(
      `${location} must use only letters, digits, underscores, or dashes, and be at most 128 characters`,
    );
  }
  return value;
}

function requireNonEmptyString(value: unknown, location: string): asserts value is string {
  if (!isString(value) || isEmpty(value.trim())) {
    throw new BadRequestException(`${location} must be a non-empty string`);
  }
}

function validateOptionalIdentifier(value: UnknownRecord, location: string): void {
  if (Object.hasOwn(value, 'id')) {
    requireNonEmptyString(value.id, `${location}.id`);
  }
}

function toRecord(value: unknown): UnknownRecord | null {
  return isPlainObject(value) ? (value as UnknownRecord) : null;
}
