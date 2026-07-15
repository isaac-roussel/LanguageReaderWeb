# Language Reader Web

A web-native, invite-only, multi-user version of Language Reader.

## Local setup

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Copy `.env.example` to `.env.local` and fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Run `npm install` and `npm run dev`.

## Translation policy

V1 does not call the paid DeepL API. The reader opens DeepL lookup URLs for selected words or phrases, with source and target languages prefilled when possible.

## Desktop compatibility

The app imports and exports the desktop lexicon JSON shape:

```json
{
  "meta": { "language": "es", "nativeLang": "en" },
  "entries": [
    { "target": "palabra", "native": ["word"], "status": 2, "scope": "word", "notes": "" }
  ]
}
```
