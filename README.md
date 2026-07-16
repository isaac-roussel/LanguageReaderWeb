# Language Reader Web

A web-native, invite-only, multi-user version of Language Reader.

## Local setup

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Copy `.env.example` to `.env.local` and fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
   These are the only Supabase values the web app needs for normal sign-in and reader use.
4. Run `npm install` and `npm run dev`.

## Production activation

The Codex Sites app is already deployed. To activate the live app:

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. In Codex Sites, set these production environment variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Redeploy the saved Sites version so the environment variables are applied.
5. Add invite rows to the `invites` table for beta users.

The browser app will show a setup screen until the Supabase environment variables are present.

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

## Import existing desktop lexicons

Small or one-off imports can be done in the app after login: create/select a lexicon and use the Import button.

For bulk migration from the desktop folder, use:

```powershell
$env:SUPABASE_URL="https://your-project.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
$env:OWNER_ID="the-auth-user-uuid"
npm run import:lexicons -- --dir "C:\Users\isaac\Documents\Language\Lexicons"
```

The importer preserves target terms, definitions, status `0-4`, word/phrase scope, notes, and review metadata when present.
The service-role key is only needed for this optional importer; do not put it in the deployed web app.
