const modelSpecs = {
  "models": {
    "gemini-3.5-flash-high": {
      "max_output_tokens": 65536,
      "thinking_budget": 10000,
      "is_thinking": true
    },
    "gemini-3.5-flash-medium": {
      "max_output_tokens": 65536,
      "thinking_budget": 4000,
      "is_thinking": true
    },
    "gemini-3.5-flash-low": {
      "max_output_tokens": 65536,
      "thinking_budget": 1000,
      "is_thinking": true
    },
    "gemini-3.5-flash-extra-low": {
      "max_output_tokens": 65536,
      "thinking_budget": 1000,
      "is_thinking": true
    },
    "gemini-3-flash": {
      "max_output_tokens": 65536,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "gemini-3.1-pro-low": {
      "max_output_tokens": 65536,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "gemini-3.1-pro-high": {
      "max_output_tokens": 65536,
      "thinking_budget": 49152,
      "is_thinking": true
    },
    "gemini-3-pro-image": {
      "max_output_tokens": 65536,
      "thinking_budget": 24576,
      "is_thinking": true
    },
    "claude-sonnet-4-6-thinking": {
      "max_output_tokens": 64000,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "claude-opus-4-6-thinking": {
      "max_output_tokens": 64000,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "gpt-oss-120b-medium": {
      "max_output_tokens": 32768,
      "thinking_budget": 0,
      "is_thinking": false
    },
    "gemini-4-argon-low": {
      "max_output_tokens": 65536,
      "thinking_budget": 8192,
      "is_thinking": true
    },
    "gemini-4-argon-medium": {
      "max_output_tokens": 65536,
      "thinking_budget": 24576,
      "is_thinking": true
    },
    "gemini-4-argon-high": {
      "max_output_tokens": 65536,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "gemini-4-hydrogen-low": {
      "max_output_tokens": 262144,
      "thinking_budget": 8192,
      "is_thinking": true
    },
    "gemini-4-hydrogen-medium": {
      "max_output_tokens": 262144,
      "thinking_budget": 24576,
      "is_thinking": true
    },
    "gemini-4-hydrogen-high": {
      "max_output_tokens": 262144,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "gemini-4-hydrogen-xhigh": {
      "max_output_tokens": 262144,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "gemini-4-hydrogen-tiered-high": {
      "max_output_tokens": 262144,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "gemini-4-hydrogen-tiered-xhigh": {
      "max_output_tokens": 262144,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "gemini-3.8-flash-low": {
      "max_output_tokens": 65536,
      "thinking_budget": 8192,
      "is_thinking": true
    },
    "gemini-3.8-flash-medium": {
      "max_output_tokens": 65536,
      "thinking_budget": 24576,
      "is_thinking": true
    },
    "gemini-3.8-flash-high": {
      "max_output_tokens": 65536,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "gemini-3.8-flash-tiered": {
      "max_output_tokens": 65536,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "claude-opus-5-5-low": {
      "max_output_tokens": 128000,
      "thinking_budget": 8192,
      "is_thinking": true
    },
    "claude-opus-5-5-medium": {
      "max_output_tokens": 128000,
      "thinking_budget": 24576,
      "is_thinking": true
    },
    "claude-opus-5-5-high": {
      "max_output_tokens": 128000,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "claude-sonnet-5-5-low": {
      "max_output_tokens": 128000,
      "thinking_budget": 8192,
      "is_thinking": true
    },
    "claude-sonnet-5-5-medium": {
      "max_output_tokens": 128000,
      "thinking_budget": 24576,
      "is_thinking": true
    },
    "claude-sonnet-5-5-high": {
      "max_output_tokens": 128000,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "gemini-4-neon-low": {
      "max_output_tokens": 262144,
      "thinking_budget": 8192,
      "is_thinking": true
    },
    "gemini-4-neon-medium": {
      "max_output_tokens": 262144,
      "thinking_budget": 24576,
      "is_thinking": true
    },
    "gemini-4-neon-high": {
      "max_output_tokens": 262144,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "gemini-4-neon-xhigh": {
      "max_output_tokens": 262144,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "gemini-pro-orchestrator-neon": {
      "max_output_tokens": 65536,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "gemini-pro-orchestrator-argon": {
      "max_output_tokens": 65536,
      "thinking_budget": 32768,
      "is_thinking": true
    },
    "gemini-pro-orchestrator": {
      "max_output_tokens": 65536,
      "thinking_budget": 32768,
      "is_thinking": true
    }
  },
  "aliases": {
    "gpt-4o": "gemini-3-flash",
    "gpt-3.5-turbo": "gemini-3-flash",
    "gemini-2.0-flash": "gemini-3-flash",
    "gemini-2.5-flash": "gemini-3-flash",
    "gemini-3.1-pro": "gemini-3.1-pro-high",
    "gemini-3.1-pro-preview": "gemini-3.1-pro-high",
    "claude-sonnet-4-6": "claude-sonnet-4-6-thinking",
    "claude-sonnet-4-5": "claude-sonnet-4-6-thinking",
    "claude-3-5-sonnet": "claude-sonnet-4-6-thinking",
    "claude-3-7-sonnet": "claude-sonnet-4-6-thinking",
    "claude-opus-4-5-thinking": "claude-opus-4-6-thinking",
    "gemini-4-argon": "gemini-4-argon-medium",
    "gemini-4-hydrogen": "gemini-4-hydrogen-medium",
    "gemini-3.8-flash": "gemini-3.8-flash-high",
    "claude-opus-5-5": "claude-opus-5-5-high",
    "claude-sonnet-5-5": "claude-sonnet-5-5-high",
    "gemini-4-neon": "gemini-4-neon-high"
  }
} as const;

export default modelSpecs;
