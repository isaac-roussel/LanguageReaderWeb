import type { LexiconEntry } from '../types';
import type { Sentence } from './text';
import { isWordToken } from './text';
import { normalizedKey } from './lexicon';

const libreTranslateBaseUrl = 'http://127.0.0.1:5000';

export type AutoFillCandidate = { key: string; word: string };
export type TranslationCheck =
  | { ok: true; translation: string }
  | { ok: false; reason: string };

type LoopbackRequestInit = RequestInit & { targetAddressSpace?: 'loopback' };

async function loopbackFetch(path: string, init: RequestInit = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const externalSignal = init.signal;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timeout = window.setTimeout(() => controller.abort(new Error('LibreTranslate request timed out.')), timeoutMs);
  try {
    return await fetch(`${libreTranslateBaseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      targetAddressSpace: 'loopback'
    } as LoopbackRequestInit);
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

export function collectAutoFillCandidates(sentences: Sentence[], entries: Map<string, LexiconEntry>): AutoFillCandidate[] {
  const candidates: AutoFillCandidate[] = [];
  const seen = new Set<string>();

  for (const sentence of sentences) {
    for (const token of sentence.tokens) {
      if (!isWordToken(token) || !/\p{L}/u.test(token)) continue;
      const word = token.trim();
      const key = normalizedKey(word);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      const existing = entries.get(key);
      if (existing && (existing.status !== 1 || existing.native.some(definition => definition.trim()))) continue;
      candidates.push({ key, word: existing?.target || word });
    }
  }

  return candidates;
}

export function checkTranslation(word: string, translation: string): TranslationCheck {
  const output = translation.replace(/\s+/g, ' ').trim();
  const lowered = output.toLowerCase();
  const source = word.trim().toLowerCase();
  const banned = new Set([
    'translation results',
    'source text',
    'dictionary',
    'translator',
    'libretranslate',
    'type or paste text to translate',
    'translate text'
  ]);

  if (!output) return { ok: false, reason: 'Empty result' };
  if (lowered === source) return { ok: false, reason: 'Same as source' };
  if (banned.has(lowered)) return { ok: false, reason: 'Matched translator interface text' };
  if (/^(log in|sign up|try again|too many requests|rate limit|captcha)/i.test(output)) {
    return { ok: false, reason: 'Translator appears unavailable or rate-limited' };
  }
  if (output.length > 120) return { ok: false, reason: 'Unusually long result' };
  return { ok: true, translation: output };
}

export async function testLibreTranslate(signal?: AbortSignal) {
  const response = await loopbackFetch('/languages', { signal }, 5000);
  if (!response.ok) throw new Error(`LibreTranslate returned HTTP ${response.status}.`);
}

export async function translateWithLibreTranslate(text: string, source: string, target: string, signal?: AbortSignal) {
  const response = await loopbackFetch('/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: text,
      source: source || 'auto',
      target: target || 'en',
      format: 'text'
    }),
    signal
  });
  if (!response.ok) throw new Error(`LibreTranslate returned HTTP ${response.status}.`);
  const data = await response.json() as { translatedText?: unknown };
  return String(data.translatedText || '').trim();
}
