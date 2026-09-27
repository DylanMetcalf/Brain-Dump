// OpenAI (ChatGPT) connection, optional. Used for two things:
//  1. Natural-sounding spoken replies (text-to-speech), much less robotic than the
//     phone's built-in web voice.
//  2. A backup brain: if Claude isn't set up or doesn't answer, the same rewrite
//     prompt goes to ChatGPT. Either way the answer is only turned into plain
//     commands for Brain Dump's own pipeline; neither model acts directly.
// The key comes from Settings (the user's encrypted secrets) or OPENAI_API_KEY.

import type { AskClaude } from '../core/assist.js';

const BASE = 'https://api.openai.com/v1';
export const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
export const OPENAI_CHAT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
export const OPENAI_VOICES = ['sage', 'coral', 'nova', 'shimmer', 'alloy', 'ash', 'ballad', 'echo', 'fable', 'onyx', 'verse'] as const;
export type OpenAIVoice = (typeof OPENAI_VOICES)[number];

type FetchLike = typeof fetch;

/** Speak text in a warm, natural voice. Returns MP3 bytes. */
export async function speak(apiKey: string, text: string, voice: string, fetchImpl: FetchLike = fetch): Promise<Buffer> {
  const res = await fetchImpl(`${BASE}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_TTS_MODEL,
      voice: (OPENAI_VOICES as readonly string[]).includes(voice) ? voice : 'sage',
      input: text.slice(0, 1500),
      instructions: 'Warm, calm and friendly, like a thoughtful personal assistant. Natural pace, conversational, never robotic.',
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`OpenAI speech failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Same contract as Claude's rewrite: prompt in, text out. */
export function makeAskOpenAI(apiKey: string, fetchImpl: FetchLike = fetch): AskClaude {
  return async (prompt: string) => {
    const res = await fetchImpl(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OPENAI_CHAT_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 1024 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`OpenAI returned ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  };
}

export async function verifyOpenAIKey(apiKey: string, fetchImpl: FetchLike = fetch): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchImpl(`${BASE}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
    if (res.ok || res.status === 429) return { ok: true };
    if (res.status === 401) return { ok: false, error: 'That key was not accepted by OpenAI.' };
    return { ok: false, error: `OpenAI returned an error (${res.status}).` };
  } catch {
    return { ok: false, error: 'Could not reach OpenAI from this server.' };
  }
}

/** Try Claude first; if it isn't there or fails, ask ChatGPT. */
export function withBackup(primary: AskClaude | undefined, backup: AskClaude | undefined): AskClaude | undefined {
  if (!primary) return backup;
  if (!backup) return primary;
  return async (prompt) => {
    try {
      return await primary(prompt);
    } catch {
      return backup(prompt);
    }
  };
}
