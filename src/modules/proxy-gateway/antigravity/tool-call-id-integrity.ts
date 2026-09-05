import { isEqual } from 'lodash-es';

interface ToolCallDefinition {
  args: unknown;
  name: string;
}

export class ToolCallIdConflictError extends Error {
  constructor() {
    super('Conflicting explicit function call id');
    this.name = 'ToolCallIdConflictError';
  }
}

/** Tracks explicit upstream IDs so retries cannot silently replace a tool invocation. */
export class ToolCallIdIntegrityTracker {
  private readonly definitions = new Map<string, ToolCallDefinition>();

  public record(toolCallId: string | undefined, name: string, args: unknown): 'new' | 'replay' {
    if (!toolCallId) {
      return 'new';
    }

    const existing = this.definitions.get(toolCallId);
    if (!existing) {
      this.definitions.set(toolCallId, { args, name });
      return 'new';
    }
    if (existing.name === name && isEqual(existing.args, args)) {
      return 'replay';
    }
    throw new ToolCallIdConflictError();
  }
}
