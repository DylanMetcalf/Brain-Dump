// Server-side Claude connection (optional). The key comes from Settings (stored in the
// user's encrypted secrets) or from ANTHROPIC_API_KEY on the server.

import Anthropic from '@anthropic-ai/sdk';
import type { AskClaude } from '../core/assist.js';

export const CLAUDE_MODEL = 'claude-opus-5';

export function makeAskClaude(apiKey: string): AskClaude {
  const client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });
  return async (prompt: string) => {
    // Refusal fallbacks route a declined request to Anthropic's recommended model server-side.
    const params = {
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: prompt }],
    };
    const response = await client.beta.messages.create(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming);
    if (response.stop_reason === 'refusal') return '[]';
    return response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

/** Check a key works before saving it, with a tiny request. */
export async function verifyKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = new Anthropic({ apiKey, timeout: 20_000, maxRetries: 0 });
    await client.messages.create({ model: CLAUDE_MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK.' }] });
    return { ok: true };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: 'That key was not accepted by Anthropic.' };
    if (err instanceof Anthropic.PermissionDeniedError) return { ok: false, error: 'That key does not have access to Claude models.' };
    if (err instanceof Anthropic.RateLimitError) return { ok: true }; // valid key, just busy
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, error: 'Could not reach Anthropic from this server.' };
    if (err instanceof Anthropic.APIError) return { ok: false, error: `Anthropic returned an error (${err.status}).` };
    return { ok: false, error: 'Could not check the key.' };
  }
}
