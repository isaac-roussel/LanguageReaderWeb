import { DesktopLexicon, EntryStatus, LexiconEntry } from '../types';

export function clampStatus(value: unknown): EntryStatus {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['ignore', 'ignored', 'name', 'proper'].includes(v)) return 0;
    if (v === 'new') return 1;
    if (v === 'seen') return 2;
    if (v === 'familiar') return 3;
    if (v === 'known') return 4;
  }
  const n = Math.floor(Number(value ?? 1));
  return Math.max(0, Math.min(4, Number.isFinite(n) ? n : 1)) as EntryStatus;
}

const hebrewMarks = /[\u0591-\u05C7]/g;
const hebrewChar = /[\u0590-\u05FF]/;

export function normalizedKey(input = ''): string {
  let out = String(input).trim().normalize('NFD');
  if (hebrewChar.test(out)) out = out.replace(hebrewMarks, '');
  return out.normalize('NFC').toLowerCase().replace(/\s+/g, ' ');
}

export function splitLines(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(x => x.trim()).filter(Boolean);
  if (!value) return [];
  return String(value).split(/\r?\n|[;•]/).map(x => x.trim()).filter(Boolean);
}

export function languageName(code?: string | null): string {
  const names: Record<string, string> = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ar: 'Arabic', he: 'Hebrew' };
  return code ? names[code] || code : 'Auto';
}

export function deepLUrl(text: string, source = 'auto', target = 'en'): string {
  const src = source || 'auto';
  const tgt = target || 'en';
  return `https://www.deepl.com/translator#${encodeURIComponent(src)}/${encodeURIComponent(tgt)}/${encodeURIComponent(text.trim())}`;
}

export function desktopEntriesFromJson(raw: string) {
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as DesktopLexicon | Array<Record<string, unknown>>;
  const obj: DesktopLexicon = Array.isArray(parsed) ? { meta: null, entries: parsed } : parsed;
  const meta = obj.meta || {};
  const entries = (obj.entries || []).map((entry) => {
    const target = String(entry.target || entry.word || entry.term || '').trim();
    const native = splitLines(entry.native || entry.definition || entry.english);
    return {
      target,
      normalized_key: normalizedKey(target),
      native,
      status: clampStatus(entry.status),
      scope: String(entry.scope || '').trim() === 'phrase' || target.includes(' ') ? 'phrase' : 'word',
      notes: String(entry.notes || ''),
      review: typeof entry.review === 'object' && entry.review ? entry.review : {}
    };
  }).filter(e => e.target && e.normalized_key);
  return { meta, entries };
}

export function toDesktopLexicon(lexicon: { target_language: string; native_language: string }, entries: LexiconEntry[]): string {
  const payload = {
    meta: { language: lexicon.target_language || 'auto', nativeLang: lexicon.native_language || 'en' },
    entries: entries
      .slice()
      .sort((a, b) => a.target.localeCompare(b.target))
      .map(e => ({ target: e.target, native: e.native || [], status: e.status, scope: e.scope, notes: e.notes || '', review: e.review || {} }))
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
