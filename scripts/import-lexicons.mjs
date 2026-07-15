import { createClient } from '@supabase/supabase-js';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  args.set(arg.slice(2), process.argv[i + 1]);
  i += 1;
}

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ownerId = process.env.OWNER_ID || args.get('owner-id');
const inputDir = args.get('dir') || 'C:\\Users\\isaac\\Documents\\Language\\Lexicons';

if (!supabaseUrl || !serviceRoleKey || !ownerId) {
  console.error('Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and OWNER_ID.');
  console.error('Example: $env:SUPABASE_URL="..."; $env:SUPABASE_SERVICE_ROLE_KEY="..."; $env:OWNER_ID="..."; npm run import:lexicons');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

function clampStatus(value) {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['ignore', 'ignored', 'name', 'proper'].includes(v)) return 0;
    if (v === 'new') return 1;
    if (v === 'seen') return 2;
    if (v === 'familiar') return 3;
    if (v === 'known') return 4;
  }
  const n = Math.floor(Number(value ?? 1));
  return Math.max(0, Math.min(4, Number.isFinite(n) ? n : 1));
}

function normalizedKey(input = '') {
  let out = String(input).trim().normalize('NFD');
  if (/[\u0590-\u05FF]/.test(out)) out = out.replace(/[\u0591-\u05C7]/g, '');
  return out.normalize('NFC').toLowerCase().replace(/\s+/g, ' ');
}

function splitLines(value) {
  if (Array.isArray(value)) return value.map(String).map(x => x.trim()).filter(Boolean);
  if (!value) return [];
  return String(value).split(/\r?\n|[;•]/).map(x => x.trim()).filter(Boolean);
}

function parseDesktopLexicon(raw) {
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const obj = Array.isArray(parsed) ? { meta: null, entries: parsed } : parsed;
  const meta = obj.meta || {};
  const entries = (obj.entries || []).map(entry => {
    const target = String(entry.target || entry.word || entry.term || '').trim();
    return {
      target,
      normalized_key: normalizedKey(target),
      native: splitLines(entry.native || entry.definition || entry.english),
      status: clampStatus(entry.status),
      scope: String(entry.scope || '').trim() === 'phrase' || target.includes(' ') ? 'phrase' : 'word',
      notes: String(entry.notes || ''),
      review: typeof entry.review === 'object' && entry.review ? entry.review : {}
    };
  }).filter(entry => entry.target && entry.normalized_key);
  return { meta, entries };
}

async function upsertChunk(table, rows, onConflict) {
  const { error } = await supabase.from(table).upsert(rows, { onConflict });
  if (error) throw error;
}

async function importFile(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const { meta, entries } = parseDesktopLexicon(raw);
  const title = basename(filePath, '.json').replace(/([a-z])([A-Z])/g, '$1 $2');

  const { data: lexicon, error: lexError } = await supabase
    .from('lexicons')
    .insert({
      owner_id: ownerId,
      title,
      target_language: meta.language || meta.targetLang || meta.lang || 'auto',
      native_language: meta.nativeLang || meta.defLang || meta.native || 'en'
    })
    .select('*')
    .single();
  if (lexError) throw lexError;

  const rows = entries.map(entry => ({
    ...entry,
    lexicon_id: lexicon.id,
    owner_id: ownerId
  }));

  for (let i = 0; i < rows.length; i += 500) {
    await upsertChunk('lexicon_entries', rows.slice(i, i + 500), 'lexicon_id,normalized_key');
  }

  console.log(`Imported ${rows.length} entries into "${title}".`);
}

const files = (await readdir(inputDir))
  .filter(name => name.toLowerCase().endsWith('.json'))
  .map(name => join(inputDir, name));

for (const file of files) {
  await importFile(file);
}

console.log(`Done. Imported ${files.length} lexicon file(s).`);
