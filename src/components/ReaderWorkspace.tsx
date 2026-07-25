import { BookOpen, Bookmark, ClipboardPaste, Download, FilePlus, Import, Library, LogOut, Plus, RotateCcw, Save, Search, Sparkles, X } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Lexicon, LexiconEntry, TextDoc } from '../types';
import { clampStatus, deepLUrl, desktopEntriesFromJson, googleTranslateUrl, normalizedKey, splitLines, toDesktopLexicon } from '../utils/lexicon';
import { checkTranslation, collectAutoFillCandidates, testLibreTranslate, translateWithLibreTranslate } from '../utils/localTranslation';
import { isWordToken, parseSentences, pickSpeechLocale, sentenceToText } from '../utils/text';

type Props = { session: Session; onSignOut: () => void };
type View = 'reader' | 'dictionary' | 'review';
type ReaderTokenSelection = { key: string; text: string; order: number };
type PopupAnchor = { left: number; top: number; right: number; bottom: number };
type ReaderPopup = { open: boolean; x: number; y: number; anchor: PopupAnchor | null; manual: boolean };
type TextBookmark = { sentenceIndex: number; tokenIndex: number };
type TextBookmarks = Record<string, TextBookmark>;
type TranslationProvider = 'google' | 'deepl';
type LocalConnection = 'idle' | 'checking' | 'connected' | 'offline';
type AutoFillFailure = { word: string; reason: string };
type AutoFillState = {
  running: boolean;
  total: number;
  processed: number;
  saved: number;
  skipped: number;
  current: string;
  message: string;
  failures: AutoFillFailure[];
};
const statusLabel = ['Ignored', 'New', 'Seen', 'Familiar', 'Known'];
const popupWidth = 380;
const popupHeight = 560;
const libreTranslateOwnerEmail = String(import.meta.env.VITE_LIBRETRANSLATE_OWNER_EMAIL || '').trim().toLowerCase();
const initialAutoFillState: AutoFillState = {
  running: false,
  total: 0,
  processed: 0,
  saved: 0,
  skipped: 0,
  current: '',
  message: '',
  failures: []
};

export default function ReaderWorkspace({ session, onSignOut }: Props) {
  const userId = session.user.id;
  const [view, setView] = useState<View>('reader');
  const [lexicons, setLexicons] = useState<Lexicon[]>([]);
  const [texts, setTexts] = useState<TextDoc[]>([]);
  const [activeLexicon, setActiveLexicon] = useState<Lexicon | null>(null);
  const [activeText, setActiveText] = useState<TextDoc | null>(null);
  const [entries, setEntries] = useState<LexiconEntry[]>([]);
  const [selected, setSelected] = useState<LexiconEntry | null>(null);
  const [query, setQuery] = useState('');
  const [readerMode, setReaderMode] = useState<'full' | 'sentence'>('sentence');
  const [sentenceIndex, setSentenceIndex] = useState(0);
  const [isReading, setIsReading] = useState(false);
  const [speechRate, setSpeechRate] = useState(0.5);
  const [isAddingText, setIsAddingText] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [readerTokenSelection, setReaderTokenSelection] = useState<ReaderTokenSelection[]>([]);
  const [readerPopup, setReaderPopup] = useState<ReaderPopup>({ open: false, x: 0, y: 0, anchor: null, manual: false });
  const [popupTokenPosition, setPopupTokenPosition] = useState<TextBookmark | null>(null);
  const [textBookmarks, setTextBookmarks] = useState<TextBookmarks>({});
  const [userSettings, setUserSettings] = useState<Record<string, unknown>>({});
  const [isSavingTranslationProvider, setIsSavingTranslationProvider] = useState(false);
  const [localConnection, setLocalConnection] = useState<LocalConnection>('idle');
  const [localConnectionMessage, setLocalConnectionMessage] = useState('Not tested');
  const [autoFillState, setAutoFillState] = useState<AutoFillState>(initialAutoFillState);
  const [notesMigrationMessage, setNotesMigrationMessage] = useState('');
  const [isMigratingNotes, setIsMigratingNotes] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const autoFillAbortRef = useRef<AbortController | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const readerPanelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);

  useEffect(() => { void refreshAll(); }, []);
  useEffect(() => { if (activeLexicon) void loadEntries(activeLexicon.id); }, [activeLexicon?.id]);
  useEffect(() => () => {
    window.speechSynthesis.cancel();
    utteranceRef.current = null;
  }, []);
  useEffect(() => setReaderTokenSelection([]), [activeText?.id, readerMode, sentenceIndex]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setReaderPopup(current => ({ ...current, open: false }));
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!readerPopup.open) return;
      const target = event.target as Node | null;
      if (target && popupRef.current?.contains(target)) return;
      if (target instanceof HTMLElement && target.closest('.reader-panel')) return;
      setReaderPopup(current => ({ ...current, open: false }));
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [readerPopup.open]);
  useEffect(() => {
    if (view !== 'reader') setReaderPopup(current => ({ ...current, open: false }));
  }, [view]);
  useEffect(() => {
    autoFillAbortRef.current?.abort();
    autoFillAbortRef.current = null;
    setAutoFillState(current => current.running
      ? { ...current, running: false, current: '', message: 'Stopped because the active text or lexicon changed.' }
      : current);
  }, [activeText?.id, activeLexicon?.id]);
  useEffect(() => () => autoFillAbortRef.current?.abort(), []);

  const entryMap = useMemo(() => new Map(entries.map(e => [e.normalized_key, e])), [entries]);
  const sentences = useMemo(() => parseSentences(activeText?.content || ''), [activeText?.content]);
  const visibleSentences = readerMode === 'sentence' ? sentences.slice(sentenceIndex, sentenceIndex + 1) : sentences;
  const selectedReaderPhrase = useMemo(() => readerTokenSelection
    .slice()
    .sort((a, b) => a.order - b.order)
    .map(token => token.text)
    .join(' '), [readerTokenSelection]);
  const lexiconStatusCounts = useMemo(() => {
    const counts = Array(statusLabel.length).fill(0);
    entries.forEach(entry => { counts[entry.status] += 1; });
    return counts;
  }, [entries]);
  const articleStatusCounts = useMemo(() => {
    const counts = Array(statusLabel.length).fill(0);
    let unknown = 0;
    let total = 0;
    sentences.forEach(sentence => sentence.tokens.forEach(token => {
      if (!isWordToken(token)) return;
      total += 1;
      const entry = entryMap.get(normalizedKey(token));
      if (entry) counts[entry.status] += 1;
      else unknown += 1;
    }));
    return { counts, unknown, total };
  }, [sentences, entryMap]);
  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(e => !q || e.target.toLowerCase().includes(q) || e.native.join(' ').toLowerCase().includes(q) || e.notes.toLowerCase().includes(q));
  }, [entries, query]);
  const familiar = entries.filter(e => e.status === 3);
  const due = entries.filter(e => e.status > 0 && e.status < 4);
  const translationProvider: TranslationProvider = userSettings.translation_provider === 'google' ? 'google' : 'deepl';
  const isLocalTranslationOwner = Boolean(libreTranslateOwnerEmail)
    && session.user.email?.trim().toLowerCase() === libreTranslateOwnerEmail;

  async function refreshAll() {
    if (!supabase) return;
    const [{ data: lx }, { data: tx }, { data: savedSettings }] = await Promise.all([
      supabase.from('lexicons').select('*').order('updated_at', { ascending: false }),
      supabase.from('texts').select('*').order('updated_at', { ascending: false }),
      supabase.from('user_settings').select('settings').eq('owner_id', userId).maybeSingle()
    ]);
    const nextLexicons = (lx || []) as Lexicon[];
    const nextTexts = (tx || []) as TextDoc[];
    setLexicons(nextLexicons);
    setTexts(nextTexts);
    setActiveLexicon(current => current || nextLexicons[0] || null);
    setActiveText(current => current || nextTexts[0] || null);
    const settings = (savedSettings?.settings && typeof savedSettings.settings === 'object' ? savedSettings.settings : {}) as Record<string, unknown>;
    setUserSettings(settings);
    const bookmarks = settings.text_bookmarks;
    setTextBookmarks(bookmarks && typeof bookmarks === 'object' ? bookmarks as TextBookmarks : {});
  }

  async function loadEntries(lexiconId: string) {
    if (!supabase) return;
    const pageSize = 1000;
    const allEntries: LexiconEntry[] = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('lexicon_entries')
        .select('*')
        .eq('lexicon_id', lexiconId)
        .order('target')
        .range(from, from + pageSize - 1);
      if (error) {
        alert(error.message);
        break;
      }
      const page = (data || []) as LexiconEntry[];
      allEntries.push(...page);
      if (page.length < pageSize) break;
    }
    setEntries(allEntries);
  }

  async function createLexicon() {
    if (!supabase) return;
    const title = window.prompt('Lexicon name', 'My Lexicon');
    if (!title) return;
    const { data, error } = await supabase.from('lexicons').insert({ owner_id: userId, title, target_language: 'auto', native_language: 'en' }).select('*').single();
    if (error) return alert(error.message);
    setLexicons([data as Lexicon, ...lexicons]);
    setActiveLexicon(data as Lexicon);
  }

  async function saveText() {
    if (!supabase || !draftText.trim()) return;
    const payload = { owner_id: userId, title: draftTitle.trim() || 'Untitled text', content: draftText, target_language: activeLexicon?.target_language || 'auto' };
    const { data, error } = await supabase.from('texts').insert(payload).select('*').single();
    if (error) return alert(error.message);
    setTexts([data as TextDoc, ...texts]);
    setActiveText(data as TextDoc);
    setDraftText('');
    setDraftTitle('');
    setSentenceIndex(0);
    setIsAddingText(false);
  }

  async function upsertEntry(target: string, patch: Partial<LexiconEntry>, forceSelect = false) {
    if (!supabase || !activeLexicon) return null;
    const key = normalizedKey(target);
    const existing = entryMap.get(key);
    const payload = {
      lexicon_id: activeLexicon.id,
      owner_id: userId,
      target,
      normalized_key: key,
      native: patch.native ?? existing?.native ?? [],
      status: clampStatus(patch.status ?? existing?.status ?? 1),
      scope: patch.scope ?? existing?.scope ?? (target.includes(' ') ? 'phrase' : 'word'),
      notes: patch.notes ?? existing?.notes ?? '',
      review: patch.review ?? existing?.review ?? {}
    };
    const query = existing
      ? supabase.from('lexicon_entries').update(payload).eq('id', existing.id).select('*').single()
      : supabase.from('lexicon_entries').insert(payload).select('*').single();
    const { data, error } = await query;
    if (error) { alert(error.message); return null; }
    const saved = data as LexiconEntry;
    setEntries(prev => existing ? prev.map(e => e.id === saved.id ? saved : e) : [...prev, saved].sort((a, b) => a.target.localeCompare(b.target)));
    setSelected(current => forceSelect || current?.normalized_key === key ? saved : current);
    return saved;
  }

  async function updateSelected(patch: Partial<LexiconEntry>) {
    if (!selected) return;
    await upsertEntry(selected.target, patch);
  }

  async function saveTextBookmark(bookmark: TextBookmark | null) {
    if (!supabase || !activeText) return;
    const nextBookmarks = { ...textBookmarks };
    if (bookmark) nextBookmarks[activeText.id] = bookmark;
    else delete nextBookmarks[activeText.id];
    const nextSettings = { ...userSettings, text_bookmarks: nextBookmarks };
    const { error } = await supabase.from('user_settings').upsert({
      owner_id: userId,
      settings: nextSettings,
      updated_at: new Date().toISOString()
    }, { onConflict: 'owner_id' });
    if (error) return alert(error.message);
    setTextBookmarks(nextBookmarks);
    setUserSettings(nextSettings);
  }

  async function saveTranslationProvider(provider: TranslationProvider) {
    if (!supabase || provider === translationProvider) return;
    const nextSettings = { ...userSettings, translation_provider: provider };
    setIsSavingTranslationProvider(true);
    const { error } = await supabase.from('user_settings').upsert({
      owner_id: userId,
      settings: nextSettings,
      updated_at: new Date().toISOString()
    }, { onConflict: 'owner_id' });
    setIsSavingTranslationProvider(false);
    if (error) return alert(error.message);
    setUserSettings(nextSettings);
  }

  function localTranslationError(error: unknown) {
    if (error instanceof Error && error.message.includes('timed out')) return error.message;
    return 'Could not reach local LibreTranslate. Start run-libretranslate.ps1, allow local network access if your browser asks, then try again.';
  }

  async function checkLocalTranslation() {
    setLocalConnection('checking');
    setLocalConnectionMessage('Checking...');
    try {
      await testLibreTranslate();
      setLocalConnection('connected');
      setLocalConnectionMessage('Connected to LibreTranslate');
      return true;
    } catch (error) {
      setLocalConnection('offline');
      setLocalConnectionMessage(localTranslationError(error));
      return false;
    }
  }

  async function saveAutoTranslation(lexiconId: string, word: string, translation: string, signal: AbortSignal) {
    if (!supabase || signal.aborted) return null;
    const key = normalizedKey(word);
    const { data: current, error: readError } = await supabase
      .from('lexicon_entries')
      .select('*')
      .eq('lexicon_id', lexiconId)
      .eq('normalized_key', key)
      .maybeSingle();
    if (readError) throw readError;
    if (signal.aborted) return null;

    const existing = current as LexiconEntry | null;
    if (existing && (existing.status !== 1 || existing.native.some(definition => definition.trim()))) return null;

    const query = existing
      ? supabase.from('lexicon_entries')
        .update({ native: [translation], status: 1 })
        .eq('id', existing.id)
        .eq('owner_id', userId)
        .select('*')
        .single()
      : supabase.from('lexicon_entries')
        .insert({
          lexicon_id: lexiconId,
          owner_id: userId,
          target: word,
          normalized_key: key,
          native: [translation],
          status: 1,
          scope: 'word',
          notes: '',
          review: {}
        })
        .select('*')
        .single();
    const { data, error } = await query;
    if (error) throw error;
    const saved = data as LexiconEntry;
    setEntries(previous => {
      const found = previous.some(entry => entry.id === saved.id);
      return found
        ? previous.map(entry => entry.id === saved.id ? saved : entry)
        : [...previous, saved].sort((a, b) => a.target.localeCompare(b.target));
    });
    setSelected(currentSelection => currentSelection?.normalized_key === key ? saved : currentSelection);
    return saved;
  }

  function stopAutoFill() {
    autoFillAbortRef.current?.abort();
  }

  async function fillNewDefinitions() {
    if (!activeLexicon || !activeText || autoFillState.running) return;
    const candidates = collectAutoFillCandidates(sentences, entryMap);
    if (candidates.length === 0) {
      setAutoFillState({ ...initialAutoFillState, message: 'No New words without definitions were found in this article.' });
      return;
    }

    const controller = new AbortController();
    autoFillAbortRef.current = controller;
    setAutoFillState({ ...initialAutoFillState, running: true, total: candidates.length });

    try {
      await testLibreTranslate(controller.signal);
      setLocalConnection('connected');
      setLocalConnectionMessage('Connected to LibreTranslate');
    } catch (error) {
      autoFillAbortRef.current = null;
      setLocalConnection('offline');
      setLocalConnectionMessage(localTranslationError(error));
      setAutoFillState({
        ...initialAutoFillState,
        message: controller.signal.aborted ? 'Stopped.' : localTranslationError(error)
      });
      return;
    }

    let processed = 0;
    let saved = 0;
    let skipped = 0;
    const failures: AutoFillFailure[] = [];
    const source = activeLexicon.target_language || 'auto';
    const target = activeLexicon.native_language || 'en';
    const lexiconId = activeLexicon.id;

    for (const candidate of candidates) {
      if (controller.signal.aborted) break;
      setAutoFillState(current => ({ ...current, current: candidate.word }));
      try {
        const output = await translateWithLibreTranslate(candidate.word, source, target, controller.signal);
        const checked = checkTranslation(candidate.word, output);
        if (!checked.ok) {
          failures.push({ word: candidate.word, reason: checked.reason });
        } else {
          const result = await saveAutoTranslation(lexiconId, candidate.word, checked.translation, controller.signal);
          if (result) saved += 1;
          else skipped += 1;
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        failures.push({
          word: candidate.word,
          reason: error instanceof Error ? error.message : 'Translation failed'
        });
      }
      processed += 1;
      setAutoFillState(current => ({
        ...current,
        processed,
        saved,
        skipped,
        failures: [...failures]
      }));
    }

    const stopped = controller.signal.aborted;
    autoFillAbortRef.current = null;
    const failed = failures.length;
    setAutoFillState({
      running: false,
      total: candidates.length,
      processed,
      saved,
      skipped,
      current: '',
      failures,
      message: stopped
        ? `Stopped after ${processed} of ${candidates.length}. Saved ${saved}.`
        : `Finished. Saved ${saved}, failed ${failed}${skipped ? `, skipped ${skipped} changed entr${skipped === 1 ? 'y' : 'ies'}` : ''}.`
    });
  }

  function goToBookmark() {
    if (!activeText) return;
    const bookmark = textBookmarks[activeText.id];
    if (!bookmark) return;
    setReaderMode('sentence');
    setSentenceIndex(bookmark.sentenceIndex);
    setReaderPopup(current => ({ ...current, open: false }));
  }

  async function deleteSelectedEntry() {
    if (!supabase || !selected) return;
    const confirmed = window.confirm(`Delete "${selected.target}" from this lexicon? This cannot be undone.`);
    if (!confirmed) return;
    const entryId = selected.id;
    const { error } = await supabase
      .from('lexicon_entries')
      .delete()
      .eq('id', entryId)
      .eq('owner_id', userId);
    if (error) return alert(error.message);
    setEntries(prev => prev.filter(entry => entry.id !== entryId));
    setSelected(null);
    setReaderTokenSelection([]);
    setReaderPopup(current => ({ ...current, open: false }));
  }

  async function importJson(file: File) {
    if (!supabase) return;
    const raw = await file.text();
    const imported = desktopEntriesFromJson(raw);
    let targetLexicon = activeLexicon;
    if (!targetLexicon) {
      const title = file.name.replace(/\.json$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2') || 'Imported Lexicon';
      const { data, error } = await supabase.from('lexicons').insert({
        owner_id: userId,
        title,
        target_language: imported.meta?.language || imported.meta?.targetLang || 'auto',
        native_language: imported.meta?.nativeLang || imported.meta?.defLang || imported.meta?.native || 'en'
      }).select('*').single();
      if (error) return alert(error.message);
      targetLexicon = data as Lexicon;
      setLexicons(prev => [targetLexicon!, ...prev]);
      setActiveLexicon(targetLexicon);
    } else if (imported.meta?.language || imported.meta?.nativeLang) {
      await supabase.from('lexicons').update({ target_language: imported.meta.language || imported.meta.targetLang || targetLexicon.target_language, native_language: imported.meta.nativeLang || imported.meta.defLang || imported.meta.native || targetLexicon.native_language }).eq('id', targetLexicon.id);
    }
    const rows = imported.entries.map(e => ({
      ...e,
      lexicon_id: targetLexicon.id,
      owner_id: userId
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('lexicon_entries').upsert(rows.slice(i, i + 500), { onConflict: 'lexicon_id,normalized_key' });
      if (error) return alert(error.message);
    }
    await loadEntries(targetLexicon.id);
    await refreshAll();
  }

  function exportJson() {
    if (!activeLexicon) return;
    const blob = new Blob([toDesktopLexicon(activeLexicon, entries)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeLexicon.title.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_lexicon.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function moveNotesToBlankDefinitions() {
    if (!supabase || !activeLexicon || isMigratingNotes) return;
    const candidates = entries.filter(entry =>
      !entry.native.some(definition => definition.trim())
      && entry.notes.trim()
    );
    if (!candidates.length) {
      setNotesMigrationMessage('No entries need this correction.');
      return;
    }
    if (!window.confirm(`Move notes into blank definitions for ${candidates.length} entries? Existing definitions will not be changed.`)) return;

    setIsMigratingNotes(true);
    setNotesMigrationMessage(`Updating 0 of ${candidates.length} entries...`);
    const updated = candidates.map(entry => ({
      ...entry,
      native: splitLines(entry.notes),
      notes: ''
    }));

    for (let i = 0; i < updated.length; i += 500) {
      const chunk = updated.slice(i, i + 500);
      const { error } = await supabase
        .from('lexicon_entries')
        .upsert(chunk, { onConflict: 'id' });
      if (error) {
        setIsMigratingNotes(false);
        setNotesMigrationMessage(`Stopped after ${i} entries: ${error.message}`);
        return;
      }
      setNotesMigrationMessage(`Updating ${Math.min(i + chunk.length, updated.length)} of ${updated.length} entries...`);
    }

    const migratedIds = new Set(updated.map(entry => entry.id));
    const entriesAfterMigration = entries.map(entry => migratedIds.has(entry.id)
      ? { ...entry, native: splitLines(entry.notes), notes: '' }
      : entry);
    const newWithDefinitions = entriesAfterMigration.filter(entry =>
      entry.status === 1
      && entry.native.some(definition => definition.trim())
    );
    const promoted = newWithDefinitions.map(entry => ({ ...entry, status: 2 as const }));

    for (let i = 0; i < promoted.length; i += 500) {
      const chunk = promoted.slice(i, i + 500);
      const { error } = await supabase
        .from('lexicon_entries')
        .upsert(chunk, { onConflict: 'id' });
      if (error) {
        setIsMigratingNotes(false);
        setNotesMigrationMessage(`Moved ${updated.length} notes, but stopped while moving New entries to Seen: ${error.message}`);
        return;
      }
    }

    const emptyNewCount = entriesAfterMigration.filter(entry =>
      entry.status === 1
      && !entry.native.some(definition => definition.trim())
    ).length;
    await loadEntries(activeLexicon.id);
    setIsMigratingNotes(false);
    setNotesMigrationMessage(`Moved ${updated.length} notes; moved ${promoted.length} defined New entries to Seen; ${emptyNewCount} empty New entries remain.`);
  }

  function stopSpeech() {
    window.speechSynthesis.cancel();
    utteranceRef.current = null;
    setIsReading(false);
  }

  function speak(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = pickSpeechLocale(activeLexicon?.target_language);
    utterance.rate = speechRate;
    utteranceRef.current = utterance;
    setIsReading(true);
    const finish = () => {
      if (utteranceRef.current === utterance) {
        utteranceRef.current = null;
        setIsReading(false);
      }
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    window.speechSynthesis.speak(utterance);
  }

  function openTranslation(text: string) {
    const source = activeLexicon?.target_language || 'auto';
    const target = activeLexicon?.native_language || 'en';
    const url = translationProvider === 'deepl'
      ? deepLUrl(text, source, target)
      : googleTranslateUrl(text, source, target);
    window.open(url, `language-reader-${translationProvider}`);
  }

  function startNewText() {
    setIsAddingText(true);
    setDraftTitle('');
    setDraftText('');
    setSelected(null);
  }

  function selectedReaderText() {
    if (selectedReaderPhrase) return selectedReaderPhrase;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return '';
    const selectedRange = selection.getRangeAt(0);
    const selectedTokens = Array.from(document.querySelectorAll<HTMLElement>('.reader-text [data-reader-token="true"]'))
      .filter(token => selectedRange.intersectsNode(token))
      .map(token => token.textContent?.trim() || '')
      .filter(Boolean);
    if (selectedTokens.length > 0) return selectedTokens.join(' ');
    return selection.toString().replace(/\s+/g, ' ').trim();
  }

  const addSelectedPhrase = useCallback(async () => {
    const phrase = selectedReaderText();
    if (!phrase) {
      alert('Select a phrase in the reader first.');
      return;
    }
    const anchor = anchorFromReaderSelection();
    const saved = await upsertEntry(phrase, { scope: 'phrase' }, true);
    if (!saved) return;
    openReaderPopup(anchor);
    setReaderTokenSelection([]);
    window.getSelection()?.removeAllRanges();
  }, [entryMap, activeLexicon?.id, userId, selectedReaderPhrase]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      if (event.altKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        void addSelectedPhrase();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [addSelectedPhrase]);

  const phraseEntries = useMemo(() => entries
    .filter(e => e.scope === 'phrase')
    .map(e => ({
      status: e.status,
      parts: normalizedKey(e.target).split(' ').filter(Boolean)
    }))
    .filter(e => e.parts.length > 1)
    .sort((a, b) => b.parts.length - a.parts.length), [entries]);

  function phraseClasses(tokens: string[]) {
    const classes = Array(tokens.length).fill('');
    const words = tokens.map((token, index) => ({ token, index, key: normalizedKey(token) })).filter(item => isWordToken(item.token));

    for (let i = 0; i < words.length; i += 1) {
      if (classes[words[i].index]) continue;
      const phrase = phraseEntries.find(candidate =>
        candidate.parts.every((part, offset) => words[i + offset]?.key === part)
      );
      if (!phrase) continue;
      phrase.parts.forEach((_, offset) => {
        const word = words[i + offset];
        if (word) classes[word.index] = ` phrase phrase-status-${phrase.status}`;
      });
      i += phrase.parts.length - 1;
    }

    return classes;
  }

  function tokenClass(token: string, phraseClass = '', isManuallySelected = false) {
    const entry = entryMap.get(normalizedKey(token));
    return `${entry ? `token status-${entry.status}` : 'token status-new'}${phraseClass}${isManuallySelected ? ' token-selected' : ''}`;
  }

  function clampPopupPosition(x: number, y: number) {
    const margin = 12;
    const maxX = Math.max(margin, window.innerWidth - popupWidth - margin);
    const maxY = Math.max(margin, window.innerHeight - popupHeight - margin);
    return {
      x: Math.min(Math.max(margin, x), maxX),
      y: Math.min(Math.max(margin, y), maxY)
    };
  }

  function popupPositionForAnchor(anchor: PopupAnchor | null) {
    if (anchor) return clampPopupPosition(anchor.right + 12, anchor.top);
    const fallback = readerPanelRef.current?.getBoundingClientRect();
    if (fallback) return clampPopupPosition(fallback.right - popupWidth - 16, fallback.top + 16);
    return clampPopupPosition(window.innerWidth - popupWidth - 16, 80);
  }

  function openReaderPopup(anchor: PopupAnchor | null, forceRecenter = false) {
    setReaderPopup(current => {
      const shouldKeepPosition = current.open && !forceRecenter;
      const position = shouldKeepPosition ? { x: current.x, y: current.y } : popupPositionForAnchor(anchor);
      return { open: true, x: position.x, y: position.y, anchor: anchor || current.anchor, manual: current.manual || shouldKeepPosition };
    });
  }

  function recenterReaderPopup() {
    setReaderPopup(current => {
      const position = popupPositionForAnchor(current.anchor);
      return { ...current, open: true, x: position.x, y: position.y, manual: false };
    });
  }

  function anchorFromReaderSelection(): PopupAnchor | null {
    const firstSelected = readerTokenSelection.slice().sort((a, b) => a.order - b.order)[0];
    if (firstSelected) {
      const token = document.querySelector<HTMLElement>(`[data-reader-token-key="${firstSelected.key}"]`);
      if (token) return token.getBoundingClientRect();
    }
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width || rect.height) return rect;
    }
    return null;
  }

  function openToken(token: string, anchor: PopupAnchor | null = null, position: TextBookmark | null = null) {
    setReaderTokenSelection([]);
    setPopupTokenPosition(position);
    openReaderPopup(anchor);
    const entry = entryMap.get(normalizedKey(token));
    setSelected(entry || null);
    if (!entry) void upsertEntry(token, { status: 1 }, true);
  }

  function toggleReaderToken(token: string, key: string, order: number) {
    window.getSelection()?.removeAllRanges();
    setReaderTokenSelection(current => {
      if (current.some(item => item.key === key)) return current.filter(item => item.key !== key);
      return [...current, { key, text: token, order }];
    });
  }

  function hasActiveSelection() {
    return Boolean(window.getSelection()?.toString().trim());
  }

  function selectedReaderSentenceIndex() {
    const manuallySelected = readerTokenSelection
      .slice()
      .sort((a, b) => a.order - b.order)[0];
    if (manuallySelected) {
      const index = Number(manuallySelected.key.split(':')[0]);
      if (Number.isInteger(index)) return index;
    }

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const selectedToken = Array.from(document.querySelectorAll<HTMLElement>('.reader-text [data-reader-token-key]'))
        .find(token => range.intersectsNode(token));
      const index = Number(selectedToken?.dataset.readerTokenKey?.split(':')[0]);
      if (Number.isInteger(index)) return index;
    }

    if (readerPopup.open && popupTokenPosition) return popupTokenPosition.sentenceIndex;
    return null;
  }

  function changeReaderMode(mode: 'full' | 'sentence') {
    if (mode === 'sentence' && readerMode === 'full') {
      const selectedIndex = selectedReaderSentenceIndex();
      if (selectedIndex !== null) {
        setSentenceIndex(Math.min(Math.max(0, selectedIndex), Math.max(0, sentences.length - 1)));
      }
    }
    setReaderMode(mode);
  }

  function needsTrailingSpace(tokens: string[], index: number) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (!next) return false;
    if (/^[,.;:!?%)\]”’]$/u.test(next)) return false;
    if (/^[(\[{“‘¿¡]$/u.test(token)) return false;
    return true;
  }

  function startPopupDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (window.matchMedia('(max-width: 700px)').matches) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, input, textarea, select')) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - readerPopup.x,
      offsetY: event.clientY - readerPopup.y
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function movePopupDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const position = clampPopupPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    setReaderPopup(current => ({ ...current, open: true, x: position.x, y: position.y, manual: true }));
  }

  function stopPopupDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><BookOpen size={22}/><strong>Language Reader</strong></div>
        <nav>
          <button className={view === 'reader' ? 'active' : ''} onClick={() => setView('reader')}><BookOpen size={17}/> Reader</button>
          <button className={view === 'dictionary' ? 'active' : ''} onClick={() => setView('dictionary')}><Library size={17}/> Dictionary</button>
          <button className={view === 'review' ? 'active' : ''} onClick={() => setView('review')}><Sparkles size={17}/> Review</button>
        </nav>
        <section className="side-section">
          <header><span>Lexicons</span><button onClick={createLexicon} title="New lexicon"><Plus size={16}/></button></header>
          <select value={activeLexicon?.id || ''} onChange={e => setActiveLexicon(lexicons.find(l => l.id === e.target.value) || null)}>
            <option value="">No lexicon</option>
            {lexicons.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
          </select>
          <div className="sidebar-counts">
            <span><strong>{entries.length}</strong> entries</span>
            {statusLabel.map((label, status) => <span key={label}><strong>{lexiconStatusCounts[status]}</strong> {label}</span>)}
          </div>
          <div className="button-row">
            <button onClick={() => importRef.current?.click()}><Import size={15}/> Import</button>
            <button onClick={exportJson} disabled={!activeLexicon}><Download size={15}/> Export</button>
          </div>
          <input ref={importRef} type="file" accept=".json,application/json" hidden onChange={e => e.target.files?.[0] && void importJson(e.target.files[0])}/>
        </section>
        <section className="side-section">
          <header><span>Texts</span><button onClick={startNewText} title="New story"><Plus size={16}/></button></header>
          <select value={activeText?.id || ''} onChange={e => { setActiveText(texts.find(t => t.id === e.target.value) || null); setSentenceIndex(0); }}>
            <option value="">No text</option>
            {texts.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </section>
        {isLocalTranslationOwner && <section className="side-section local-translation">
          <header><span>Local translation</span><Sparkles size={15}/></header>
          <p className={`local-status ${localConnection}`}>{localConnectionMessage}</p>
          <button
            onClick={() => void checkLocalTranslation()}
            disabled={localConnection === 'checking' || autoFillState.running}
          >{localConnection === 'checking' ? 'Checking...' : 'Test connection'}</button>
          <button
            className="primary"
            onClick={() => void fillNewDefinitions()}
            disabled={!activeText || !activeLexicon || autoFillState.running}
          >Fill new definitions</button>
          {autoFillState.running && <>
            <progress max={autoFillState.total || 1} value={autoFillState.processed}/>
            <p className="local-progress">{autoFillState.processed} / {autoFillState.total}{autoFillState.current ? ` · ${autoFillState.current}` : ''}</p>
            <button className="danger" onClick={stopAutoFill}>Stop</button>
          </>}
          {!autoFillState.running && autoFillState.message && <p className="local-result">{autoFillState.message}</p>}
          {!autoFillState.running && autoFillState.failures.length > 0 && <details>
            <summary>{autoFillState.failures.length} failed word{autoFillState.failures.length === 1 ? '' : 's'}</summary>
            <ul>{autoFillState.failures.map(failure => <li key={failure.word}><strong>{failure.word}</strong>: {failure.reason}</li>)}</ul>
          </details>}
        </section>}
        <button className="ghost signout" onClick={onSignOut}><LogOut size={16}/> Sign out</button>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">Invite-only web beta</p><h1>{view === 'reader' ? activeText?.title || 'Reader' : view === 'dictionary' ? 'Dictionary' : 'Review'}</h1></div>
        </header>

        {view === 'reader' && <section className="reader-grid">
          <div ref={readerPanelRef} className="panel reader-panel">
            {(!activeText || isAddingText) && <div className="new-text">
              <input placeholder="Text title" value={draftTitle} onChange={e => setDraftTitle(e.target.value)} />
              <textarea placeholder="Paste a reading text here..." value={draftText} onChange={e => setDraftText(e.target.value)} />
              <div className="button-row">
                <button className="primary" onClick={saveText}><FilePlus size={16}/> Save story</button>
                {activeText && <button onClick={() => setIsAddingText(false)}>Cancel</button>}
              </div>
            </div>}
            {activeText && !isAddingText && <>
              <div className="reader-toolbar">
                <div className="segmented small"><button className={readerMode === 'sentence' ? 'active' : ''} onClick={() => changeReaderMode('sentence')}>Sentence</button><button className={readerMode === 'full' ? 'active' : ''} onClick={() => changeReaderMode('full')}>Full text</button></div>
                {readerMode === 'sentence' && <div className="pager"><button onClick={() => setSentenceIndex(Math.max(0, sentenceIndex - 1))}>Previous</button><span>{Math.min(sentenceIndex + 1, sentences.length)} / {sentences.length}</span><button onClick={() => setSentenceIndex(Math.min(sentences.length - 1, sentenceIndex + 1))}>Next</button></div>}
                <div className="button-row reader-actions">
                  <button disabled={!activeLexicon} onClick={() => void addSelectedPhrase()}><Search size={16}/> Look up</button>
                  <button disabled={!activeLexicon} onClick={() => void addSelectedPhrase()}>Add phrase</button>
                  {selectedReaderPhrase && <button className="ghost" onClick={() => setReaderTokenSelection([])}>Clear</button>}
                  <button disabled={!activeText || !textBookmarks[activeText.id]} onClick={goToBookmark}><Bookmark size={16}/> Go to bookmark</button>
                </div>
                <label className="rate-control">Speed <input type="range" min="0.25" max="1" step="0.05" value={speechRate} onChange={event => setSpeechRate(Number(event.target.value))}/><span>{speechRate.toFixed(2)}x</span></label>
                <button className={isReading ? 'danger' : ''} onClick={() => isReading ? stopSpeech() : speak(sentenceToText(visibleSentences.flatMap(s => s.tokens)))}>{isReading ? 'Stop' : 'Read'}</button>
                {selectedReaderPhrase && <div className="phrase-preview">{selectedReaderPhrase}</div>}
              </div>
              <section className="reader-summary">
                <p>Ctrl-click multiple words, then click Look up to create or open a phrase.</p>
                <div className="reader-counts">
                  <span><strong>{articleStatusCounts.total}</strong> words</span>
                  <span><strong>{articleStatusCounts.unknown}</strong> Unknown</span>
                  {statusLabel.map((label, status) => <span key={label}><strong>{articleStatusCounts.counts[status]}</strong> {label}</span>)}
                </div>
              </section>
              <article className="reader-text">
                {visibleSentences.map((s, si) => {
                  const sentenceOrder = readerMode === 'sentence' ? sentenceIndex + si : si;
                  const phraseTokenClasses = phraseClasses(s.tokens);
                  return <p key={`${s.raw}-${si}`}>{s.tokens.map((token, ti) => {
                    const trailingSpace = needsTrailingSpace(s.tokens, ti) ? ' ' : '';
                    return isWordToken(token)
                    ? (() => {
                      const readerTokenKey = `${sentenceOrder}:${ti}`;
                      const isManuallySelected = readerTokenSelection.some(item => item.key === readerTokenKey);
                      return <Fragment key={`${token}-${ti}`}>
                        <span
                        key={`${token}-${ti}`}
                        role="button"
                        tabIndex={0}
                        data-reader-token="true"
                        data-reader-token-key={readerTokenKey}
                        className={`${tokenClass(token, phraseTokenClasses[ti], isManuallySelected)}${activeText && textBookmarks[activeText.id]?.sentenceIndex === sentenceOrder && textBookmarks[activeText.id]?.tokenIndex === ti ? ' token-bookmarked' : ''}`}
                        onClick={event => {
                          if (event.ctrlKey || event.metaKey) {
                            event.preventDefault();
                            toggleReaderToken(token, readerTokenKey, sentenceOrder * 10000 + ti);
                            return;
                          }
                          if (!hasActiveSelection()) openToken(token, event.currentTarget.getBoundingClientRect(), { sentenceIndex: sentenceOrder, tokenIndex: ti });
                        }}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            openToken(token, event.currentTarget.getBoundingClientRect(), { sentenceIndex: sentenceOrder, tokenIndex: ti });
                          }
                        }}
                        >{token}</span>
                        {trailingSpace}
                      </Fragment>;
                    })()
                    : <Fragment key={`${token}-${ti}`}><span className="punct">{token}</span>{trailingSpace}</Fragment>;
                  })}</p>;
                })}
              </article>
            </>}
          </div>
          {selected && readerPopup.open && <div
            ref={popupRef}
            className="reader-popup panel"
            style={{ left: readerPopup.x, top: readerPopup.y }}
          >
            <div
              className="reader-popup-titlebar"
              onPointerDown={startPopupDrag}
              onPointerMove={movePopupDrag}
              onPointerUp={stopPopupDrag}
              onPointerCancel={stopPopupDrag}
            >
              <span>Lexicon entry</span>
              <div className="button-row">
                <button
                  className={activeText && popupTokenPosition && textBookmarks[activeText.id]?.sentenceIndex === popupTokenPosition.sentenceIndex && textBookmarks[activeText.id]?.tokenIndex === popupTokenPosition.tokenIndex ? 'bookmark-active' : 'ghost'}
                  disabled={!activeText || !popupTokenPosition}
                  onClick={() => {
                    if (!activeText || !popupTokenPosition) return;
                    const current = textBookmarks[activeText.id];
                    const isCurrent = current?.sentenceIndex === popupTokenPosition.sentenceIndex && current?.tokenIndex === popupTokenPosition.tokenIndex;
                    void saveTextBookmark(isCurrent ? null : popupTokenPosition);
                  }}
                  title="Bookmark this spot"
                  aria-label="Bookmark this spot"
                ><Bookmark size={15}/></button>
                <button className="ghost" onClick={recenterReaderPopup} title="Recenter"><RotateCcw size={15}/></button>
                <button className="ghost" onClick={() => setReaderPopup(current => ({ ...current, open: false }))} title="Close"><X size={15}/></button>
              </div>
            </div>
            <div className="entry-editor reader-popup-editor">
              <EntryEditorFields selected={selected} onChange={updateSelected} onTranslate={openTranslation} translationProvider={translationProvider} onTranslationProviderChange={saveTranslationProvider} isSavingTranslationProvider={isSavingTranslationProvider} onDelete={deleteSelectedEntry} />
            </div>
          </div>}
        </section>}

        {view === 'dictionary' && <section className="panel dictionary-panel">
          <label className="search"><Search size={16}/><input placeholder="Search target, definition, or notes" value={query} onChange={e => setQuery(e.target.value)} /></label>
          <div className="button-row">
            <button disabled={isMigratingNotes} onClick={() => void moveNotesToBlankDefinitions()}>
              {isMigratingNotes ? 'Moving notes...' : 'Move notes to blank definitions'}
            </button>
            {notesMigrationMessage && <span>{notesMigrationMessage}</span>}
          </div>
          <div className="entry-list">{filteredEntries.map(e => <button key={e.id} onClick={() => setSelected(e)} className={selected?.id === e.id ? 'active' : ''}><strong>{e.target}</strong><span>{e.native.join(' • ') || 'No definition'}</span><em>{statusLabel[e.status]}</em></button>)}</div>
          <EntryEditor selected={selected} onChange={updateSelected} onTranslate={openTranslation} translationProvider={translationProvider} onTranslationProviderChange={saveTranslationProvider} isSavingTranslationProvider={isSavingTranslationProvider} onDelete={deleteSelectedEntry} />
        </section>}

        {view === 'review' && <section className="review-grid">
          <ReviewColumn title="Familiar flashcards" entries={familiar} actionLabel="Mark seen" onAction={e => upsertEntry(e.target, { status: 2 })}/>
          <ReviewColumn title="SRS practice" entries={due} actionLabel="Mark known" onAction={e => upsertEntry(e.target, { status: 4 })}/>
        </section>}
      </main>
    </div>
  );
}

type EntryEditorProps = {
  selected: LexiconEntry | null;
  onChange: (patch: Partial<LexiconEntry>) => void;
  onTranslate: (text: string) => void;
  translationProvider: TranslationProvider;
  onTranslationProviderChange: (provider: TranslationProvider) => void;
  isSavingTranslationProvider: boolean;
  onDelete: () => void;
};

function EntryEditor({ selected, onChange, onTranslate, translationProvider, onTranslationProviderChange, isSavingTranslationProvider, onDelete }: EntryEditorProps) {
  if (!selected) return <aside className="panel entry-editor empty"><p>Select a word to edit its lexicon entry.</p></aside>;
  return <aside className="panel entry-editor">
    <EntryEditorFields selected={selected} onChange={onChange} onTranslate={onTranslate} translationProvider={translationProvider} onTranslationProviderChange={onTranslationProviderChange} isSavingTranslationProvider={isSavingTranslationProvider} onDelete={onDelete} />
  </aside>;
}

function EntryEditorFields({ selected, onChange, onTranslate, translationProvider, onTranslationProviderChange, isSavingTranslationProvider, onDelete }: Omit<EntryEditorProps, 'selected'> & { selected: LexiconEntry }) {
  const [nativeText, setNativeText] = useState('');
  const [notes, setNotes] = useState('');
  const [needsSeenPrompt, setNeedsSeenPrompt] = useState(false);
  const definitionRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setNativeText((selected.native || []).join('\n')); setNotes(selected.notes || ''); }, [selected.id, selected.native, selected.notes]);
  useEffect(() => setNeedsSeenPrompt(false), [selected.id]);
  const saveWithDrafts = (patch: Partial<LexiconEntry> = {}, promptToMarkSeen = false) => {
    const nextNative = patch.native ?? splitLines(nativeText);
    const definitionChanged = nextNative.join('\n') !== (selected.native || []).join('\n');
    const remainsNew = (patch.status ?? selected.status) === 1;
    const shouldOfferSeen = (needsSeenPrompt || definitionChanged) && nextNative.length > 0 && remainsNew;
    const shouldMarkSeen = promptToMarkSeen && shouldOfferSeen
      && window.confirm(`A definition was added to "${selected.target}". Move it to Seen?`);
    if (!remainsNew || promptToMarkSeen) setNeedsSeenPrompt(false);
    onChange({ native: nextNative, notes, ...patch, ...(shouldMarkSeen ? { status: 2 } : {}) });
  };
  const isLeavingEntry = (event: { currentTarget: HTMLElement; relatedTarget: EventTarget | null }) => {
    const editor = event.currentTarget.closest('.entry-editor');
    return !(event.relatedTarget instanceof Node && editor?.contains(event.relatedTarget));
  };
  async function pasteDefinition() {
    try {
      const pasted = await navigator.clipboard.readText();
      if (!pasted) return;
      const textarea = definitionRef.current;
      const start = textarea?.selectionStart ?? nativeText.length;
      const end = textarea?.selectionEnd ?? nativeText.length;
      const nextText = `${nativeText.slice(0, start)}${pasted}${nativeText.slice(end)}`;
      setNativeText(nextText);
      setNeedsSeenPrompt(selected.status === 1 && splitLines(nextText).join('\n') !== (selected.native || []).join('\n'));
      requestAnimationFrame(() => {
        textarea?.focus();
        textarea?.setSelectionRange(start + pasted.length, start + pasted.length);
      });
    } catch {
      alert('Clipboard access was blocked. Allow clipboard access for this site, then try Paste again.');
    }
  }
  return <>
    <header>
      <h2>{selected.target}</h2>
      <div className="translator-controls">
        <select
          aria-label="Translation service"
          value={translationProvider}
          disabled={isSavingTranslationProvider}
          onChange={e => void onTranslationProviderChange(e.target.value as TranslationProvider)}
        >
          <option value="google">Google Translate</option>
          <option value="deepl">DeepL</option>
        </select>
        <button onClick={() => onTranslate(selected.target)}>Translate</button>
      </div>
    </header>
    <label>Status<select value={selected.status} onChange={e => saveWithDrafts({ status: clampStatus(e.target.value) })}>{statusLabel.map((label, i) => <option key={label} value={i}>{i} - {label}</option>)}</select></label>
    <div className="status-actions">{statusLabel.map((label, status) => <button key={label} className={selected.status === status ? 'active' : ''} onClick={() => saveWithDrafts({ status: clampStatus(status) })}>{label}</button>)}</div>
    <label>Definitions<span className="field-label-actions"><button type="button" onClick={() => void pasteDefinition()}><ClipboardPaste size={14}/> Paste</button></span><textarea ref={definitionRef} value={nativeText} onChange={e => { setNativeText(e.target.value); setNeedsSeenPrompt(selected.status === 1 && splitLines(e.target.value).join('\n') !== (selected.native || []).join('\n')); }} onBlur={e => { if (isLeavingEntry(e)) saveWithDrafts({}, true); }}/></label>
    <label>Notes<textarea value={notes} onChange={e => setNotes(e.target.value)} onBlur={e => { if (isLeavingEntry(e)) saveWithDrafts({}, true); }}/></label>
    <div className="entry-editor-actions">
      <button className="primary" onClick={() => saveWithDrafts({}, true)}><Save size={16}/> Save</button>
      <button className="danger" onClick={onDelete}>Delete</button>
    </div>
  </>;
}

function ReviewColumn({ title, entries, actionLabel, onAction }: { title: string; entries: LexiconEntry[]; actionLabel: string; onAction: (entry: LexiconEntry) => void }) {
  const [index, setIndex] = useState(0);
  const entry = entries[index % Math.max(entries.length, 1)];
  return <section className="panel review-card"><h2>{title}</h2>{entry ? <><div className="flash-term">{entry.target}</div><div className="flash-defs">{entry.native.join(' • ') || 'No definition yet'}</div><div className="button-row"><button onClick={() => setIndex(index + 1)}>Next</button><button className="primary" onClick={() => onAction(entry)}>{actionLabel}</button></div></> : <p>No entries here yet.</p>}</section>;
}
