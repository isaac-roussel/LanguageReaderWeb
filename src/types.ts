export type EntryStatus = 0 | 1 | 2 | 3 | 4;
export type EntryScope = 'word' | 'phrase';

export type Lexicon = {
  id: string;
  owner_id: string;
  title: string;
  target_language: string;
  native_language: string;
  created_at: string;
  updated_at: string;
};

export type LexiconEntry = {
  id: string;
  lexicon_id: string;
  owner_id: string;
  target: string;
  normalized_key: string;
  native: string[];
  status: EntryStatus;
  scope: EntryScope;
  notes: string;
  review: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type TextDoc = {
  id: string;
  owner_id: string;
  title: string;
  content: string;
  target_language: string;
  last_sentence_index: number;
  created_at: string;
  updated_at: string;
};

export type DesktopLexicon = {
  meta?: { language?: string; targetLang?: string; nativeLang?: string; defLang?: string; native?: string } | null;
  entries?: Array<Partial<LexiconEntry> & { word?: string; term?: string; definition?: string | string[]; english?: string | string[] }>;
};
