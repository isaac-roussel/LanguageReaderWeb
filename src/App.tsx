import { useCallback, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import AuthGate from './components/AuthGate';
import ReaderWorkspace from './components/ReaderWorkspace';
import { supabase } from './lib/supabase';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const handleSession = useCallback((next: Session | null) => setSession(next), []);
  const signOut = async () => {
    await supabase?.auth.signOut();
    setSession(null);
  };
  return session ? <ReaderWorkspace session={session} onSignOut={signOut} /> : <AuthGate onSession={handleSession} />;
}
