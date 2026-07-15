export type Sentence = { raw: string; tokens: string[] };

export function tokenize(text: string): string[] {
  return Array.from(text.matchAll(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)?|[^\s]/gu)).map(m => m[0]);
}

export function parseSentences(text: string): Sentence[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const parts = normalized.match(/[^.!?。！？\n]+(?:[.!?。！？]+|$)|\n+/g) || [normalized];
  return parts.map(p => p.trim()).filter(Boolean).map(raw => ({ raw, tokens: tokenize(raw) }));
}

export function sentenceToText(tokens: string[]): string {
  return tokens.join(' ').replace(/\s+([,.;:!?%)\]”’])/g, '$1').replace(/([([{“‘])\s+/g, '$1');
}

export function isWordToken(token: string): boolean {
  return /[\p{L}\p{M}\p{N}]/u.test(token);
}

export function pickSpeechLocale(lang?: string | null): string {
  const base = (lang || 'en').toLowerCase().slice(0, 2);
  const map: Record<string, string> = { es: 'es-MX', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', pt: 'pt-BR', ru: 'ru-RU', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN', ar: 'ar-SA', he: 'he-IL', en: 'en-US' };
  return map[base] || base;
}
