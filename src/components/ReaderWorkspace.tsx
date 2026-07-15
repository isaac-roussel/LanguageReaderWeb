import { BookOpen, Download, FilePlus, Import, Library, LogOut, Plus, Save, Search, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Lexicon, LexiconEntry, TextDoc } from '../types';
import { clampStatus, deepLUrl, desktopEntriesFromJson, normalizedKey, splitLines, toDesktopLexicon } from '../utils/lexicon';
import { isWordToken, parseSentences, pickSpeechLocale, sentenceToText } from '../utils/text';

type Props = { session: Session; onSignOut: () => void };
type View = 'reader' | 'dictionary' | 'review';
const statusLabel = ['Ignored', 'New', 'Seen', 'Familiar', 'Known'];

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
  const [draftText, setDraftText] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => { void refreshAll(); }, []);
  useEffect(() => { if (activeLexicon) void loadEntries(activeLexicon.id); }, [activeLexicon?.id]);

  const entryMap = useMemo(() => new Map(entries.map(e => [e.normalized_key, e])), [entries]);
  const sentences = useMemo(() => parseSentences(activeText?.content || ''), [activeText?.content]);
  const visibleSentences = readerMode === 'sentence' ? sentences.slice(sentenceIndex, sentenceIndex + 1) : sentences;
  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(e => !q || e.target.toLowerCase().includes(q) || e.native.join(' ').toLowerCase().includes(q) || e.notes.toLowerCase().includes(q));
  }, [entries, query]);
  const familiar = entries.filter(e => e.status === 3);
  const due = entries.filter(e => e.status > 0 && e.status < 4);

  async function refreshAll() {
    if (!supabase) return;
    const [{ data: lx }, { data: tx }] = await Promise.all([
      supabase.from('lexicons').select('*').order('updated_at', { ascending: false }),
      supabase.from('texts').select('*').order('updated_at', { ascending: false })
    ]);
    const nextLexicons = (lx || []) as Lexicon[];
    const nextTexts = (tx || []) as TextDoc[];
    setLexicons(nextLexicons);
    setTexts(nextTexts);
    setActiveLexicon(current => current || nextLexicons[0] || null);
    setActiveText(current => current || nextTexts[0] || null);
  }

  async function loadEntries(lexiconId: string) {
    if (!supabase) return;
    const { data } = await supabase.from('lexicon_entries').select('*').eq('lexicon_id', lexiconId).order('target');
    setEntries((data || []) as LexiconEntry[]);
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
  }

  async function upsertEntry(target: string, patch: Partial<LexiconEntry>) {
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
    setSelected(saved);
    return saved;
  }

  async function updateSelected(patch: Partial<LexiconEntry>) {
    if (!selected) return;
    await upsertEntry(selected.target, patch);
  }

  async function importJson(file: File) {
    if (!supabase || !activeLexicon) return;
    const raw = await file.text();
    const imported = desktopEntriesFromJson(raw);
    if (imported.meta?.language || imported.meta?.nativeLang) {
      await supabase.from('lexicons').update({ target_language: imported.meta.language || imported.meta.targetLang || activeLexicon.target_language, native_language: imported.meta.nativeLang || imported.meta.defLang || imported.meta.native || activeLexicon.native_language }).eq('id', activeLexicon.id);
    }
    const rows = imported.entries.map(e => ({
      ...e,
      lexicon_id: activeLexicon.id,
      owner_id: userId
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('lexicon_entries').upsert(rows.slice(i, i + 500), { onConflict: 'lexicon_id,normalized_key' });
      if (error) return alert(error.message);
    }
    await loadEntries(activeLexicon.id);
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

  function speak(text: string) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = pickSpeechLocale(activeLexicon?.target_language);
    window.speechSynthesis.speak(utterance);
  }

  function openDeepL(text: string) {
    window.open(deepLUrl(text, activeLexicon?.target_language || 'auto', activeLexicon?.native_language || 'en'), '_blank', 'noopener,noreferrer');
  }

  function tokenClass(token: string) {
    const entry = entryMap.get(normalizedKey(token));
    return entry ? `token status-${entry.status}` : 'token status-new';
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
          <div className="button-row">
            <button onClick={() => importRef.current?.click()} disabled={!activeLexicon}><Import size={15}/> Import</button>
            <button onClick={exportJson} disabled={!activeLexicon}><Download size={15}/> Export</button>
          </div>
          <input ref={importRef} type="file" accept=".json,application/json" hidden onChange={e => e.target.files?.[0] && void importJson(e.target.files[0])}/>
        </section>
        <section className="side-section">
          <header><span>Texts</span></header>
          <select value={activeText?.id || ''} onChange={e => { setActiveText(texts.find(t => t.id === e.target.value) || null); setSentenceIndex(0); }}>
            <option value="">No text</option>
            {texts.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </section>
        <button className="ghost signout" onClick={onSignOut}><LogOut size={16}/> Sign out</button>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">Invite-only web beta</p><h1>{view === 'reader' ? activeText?.title || 'Reader' : view === 'dictionary' ? 'Dictionary' : 'Review'}</h1></div>
          <div className="stats"><span>{entries.length} entries</span><span>{familiar.length} familiar</span><span>{due.length} due-ish</span></div>
        </header>

        {view === 'reader' && <section className="reader-grid">
          <div className="panel reader-panel">
            {!activeText && <div className="new-text">
              <input placeholder="Text title" value={draftTitle} onChange={e => setDraftTitle(e.target.value)} />
              <textarea placeholder="Paste a reading text here..." value={draftText} onChange={e => setDraftText(e.target.value)} />
              <button className="primary" onClick={saveText}><FilePlus size={16}/> Save text</button>
            </div>}
            {activeText && <>
              <div className="reader-toolbar">
                <div className="segmented small"><button className={readerMode === 'sentence' ? 'active' : ''} onClick={() => setReaderMode('sentence')}>Sentence</button><button className={readerMode === 'full' ? 'active' : ''} onClick={() => setReaderMode('full')}>Full text</button></div>
                {readerMode === 'sentence' && <div className="pager"><button onClick={() => setSentenceIndex(Math.max(0, sentenceIndex - 1))}>Previous</button><span>{Math.min(sentenceIndex + 1, sentences.length)} / {sentences.length}</span><button onClick={() => setSentenceIndex(Math.min(sentences.length - 1, sentenceIndex + 1))}>Next</button></div>}
                <button onClick={() => speak(sentenceToText(visibleSentences.flatMap(s => s.tokens)))}>Read</button>
              </div>
              <article className="reader-text">
                {visibleSentences.map((s, si) => <p key={`${s.raw}-${si}`}>{s.tokens.map((token, ti) => isWordToken(token)
                  ? <button key={`${token}-${ti}`} className={tokenClass(token)} onClick={() => { const entry = entryMap.get(normalizedKey(token)); setSelected(entry || null); if (!entry) void upsertEntry(token, { status: 1 }); }}>{token}</button>
                  : <span key={`${token}-${ti}`} className="punct">{token}</span>)}</p>)}
              </article>
            </>}
          </div>
          <EntryEditor selected={selected} onChange={updateSelected} onDeepL={openDeepL} />
        </section>}

        {view === 'dictionary' && <section className="panel dictionary-panel">
          <label className="search"><Search size={16}/><input placeholder="Search target, definition, or notes" value={query} onChange={e => setQuery(e.target.value)} /></label>
          <div className="entry-list">{filteredEntries.map(e => <button key={e.id} onClick={() => setSelected(e)} className={selected?.id === e.id ? 'active' : ''}><strong>{e.target}</strong><span>{e.native.join(' • ') || 'No definition'}</span><em>{statusLabel[e.status]}</em></button>)}</div>
          <EntryEditor selected={selected} onChange={updateSelected} onDeepL={openDeepL} />
        </section>}

        {view === 'review' && <section className="review-grid">
          <ReviewColumn title="Familiar flashcards" entries={familiar} actionLabel="Mark seen" onAction={e => upsertEntry(e.target, { status: 2 })}/>
          <ReviewColumn title="SRS practice" entries={due} actionLabel="Mark known" onAction={e => upsertEntry(e.target, { status: 4 })}/>
        </section>}
      </main>
    </div>
  );
}

function EntryEditor({ selected, onChange, onDeepL }: { selected: LexiconEntry | null; onChange: (patch: Partial<LexiconEntry>) => void; onDeepL: (text: string) => void }) {
  const [nativeText, setNativeText] = useState('');
  const [notes, setNotes] = useState('');
  useEffect(() => { setNativeText((selected?.native || []).join('\n')); setNotes(selected?.notes || ''); }, [selected?.id]);
  if (!selected) return <aside className="panel entry-editor empty"><p>Select a word to edit its lexicon entry.</p></aside>;
  return <aside className="panel entry-editor">
    <header><h2>{selected.target}</h2><button onClick={() => onDeepL(selected.target)}>DeepL</button></header>
    <label>Status<select value={selected.status} onChange={e => onChange({ status: clampStatus(e.target.value) })}>{statusLabel.map((label, i) => <option key={label} value={i}>{i} - {label}</option>)}</select></label>
    <label>Definitions<textarea value={nativeText} onChange={e => setNativeText(e.target.value)} onBlur={() => onChange({ native: splitLines(nativeText) })}/></label>
    <label>Notes<textarea value={notes} onChange={e => setNotes(e.target.value)} onBlur={() => onChange({ notes })}/></label>
    <button className="primary" onClick={() => onChange({ native: splitLines(nativeText), notes })}><Save size={16}/> Save</button>
  </aside>;
}

function ReviewColumn({ title, entries, actionLabel, onAction }: { title: string; entries: LexiconEntry[]; actionLabel: string; onAction: (entry: LexiconEntry) => void }) {
  const [index, setIndex] = useState(0);
  const entry = entries[index % Math.max(entries.length, 1)];
  return <section className="panel review-card"><h2>{title}</h2>{entry ? <><div className="flash-term">{entry.target}</div><div className="flash-defs">{entry.native.join(' • ') || 'No definition yet'}</div><div className="button-row"><button onClick={() => setIndex(index + 1)}>Next</button><button className="primary" onClick={() => onAction(entry)}>{actionLabel}</button></div></> : <p>No entries here yet.</p>}</section>;
}
