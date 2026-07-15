import { useEffect, useState } from 'react';
import { LogIn, UserPlus } from 'lucide-react';
import { hasSupabaseConfig, supabase } from '../lib/supabase';
import type { Session } from '@supabase/supabase-js';

type Props = { onSession: (session: Session | null) => void };

export default function AuthGate({ onSession }: Props) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => onSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => onSession(session));
    return () => data.subscription.unsubscribe();
  }, [onSession]);

  if (!hasSupabaseConfig) {
    return (
      <main className="setup-screen">
        <section className="setup-panel">
          <h1>Language Reader Web</h1>
          <p>This deployment is built, but Supabase is not connected yet.</p>
          <ol>
            <li>Create a Supabase project.</li>
            <li>Run <code>supabase/schema.sql</code>.</li>
            <li>Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> for the deployed site.</li>
          </ol>
        </section>
      </main>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setMessage('');
    try {
      if (mode === 'signup') {
        const { data: invite, error: inviteError } = await supabase
          .from('invites')
          .select('id,email,code')
          .eq('code', inviteCode.trim())
          .is('accepted_at', null)
          .maybeSingle();
        if (inviteError) throw inviteError;
        if (!invite || invite.email.toLowerCase() !== email.trim().toLowerCase()) {
          setMessage('That invite does not match this email address.');
          return;
        }
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
        if (error) throw error;
        if (data.user) {
          await supabase.from('invites').update({ accepted_by: data.user.id, accepted_at: new Date().toISOString() }).eq('id', invite.id);
          setMessage('Account created. Check your email if confirmation is enabled.');
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-panel">
        <div>
          <p className="eyebrow">Invite-only beta</p>
          <h1>Language Reader Web</h1>
          <p className="lede">Read text, build your own lexicon, and review words from any browser.</p>
        </div>
        <form onSubmit={submit} className="auth-form">
          <div className="segmented">
            <button type="button" className={mode === 'signin' ? 'active' : ''} onClick={() => setMode('signin')}><LogIn size={16}/> Sign in</button>
            <button type="button" className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}><UserPlus size={16}/> Join beta</button>
          </div>
          <label>Email<input value={email} onChange={e => setEmail(e.target.value)} type="email" required /></label>
          <label>Password<input value={password} onChange={e => setPassword(e.target.value)} type="password" minLength={6} required /></label>
          {mode === 'signup' && <label>Invite code<input value={inviteCode} onChange={e => setInviteCode(e.target.value)} required /></label>}
          <button className="primary" disabled={busy}>{busy ? 'Working...' : mode === 'signup' ? 'Create account' : 'Sign in'}</button>
          {message && <p className="form-message">{message}</p>}
        </form>
      </section>
    </main>
  );
}
