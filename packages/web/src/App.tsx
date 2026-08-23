import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { AuthScreen } from './screens/AuthScreen.tsx';
import { AppShell } from './screens/AppShell.tsx';
import { Logo } from './components/Logo.tsx';
import { Spinner } from './components/primitives.tsx';
import { AlertIcon } from './components/icons.tsx';
import { useSession, applyAppearanceToDocument } from './store/session.ts';
import { useChats, connectChatEvents } from './store/chats.ts';
import { onApiEvent } from './lib/api.ts';
import { ToastStack } from './components/ToastStack.tsx';

export function App() {
  const phase = useSession((s) => s.phase);
  const blockingError = useSession((s) => s.blockingError);
  const boot = useSession((s) => s.boot);
  const user = useSession((s) => s.user);

  useEffect(() => {
    void boot();
  }, [boot]);

  // A 401 from anywhere drops straight back to the sign-in screen rather than
  // leaving the UI in a half-authenticated state.
  useEffect(
    () =>
      onApiEvent((event) => {
        if (event !== 'unauthorized') return;
        if (useSession.getState().phase !== 'signed-in') return;
        useChats.getState().reset();
        useSession.setState({ phase: 'signed-out', user: null, deviceId: null });
      }),
    [],
  );

  useEffect(() => (phase === 'signed-in' ? connectChatEvents() : undefined), [phase]);

  // Mirror the appearance choice into localStorage purely so the inline script
  // in index.html can paint the right theme before React mounts. It holds no
  // secrets — only a theme name.
  useEffect(() => {
    if (!user) return;
    try {
      localStorage.setItem('wolff.appearance', JSON.stringify(user.appearance));
    } catch {
      /* storage may be blocked; the theme simply flashes once */
    }
  }, [user]);

  // Follow the OS when the user asked for "system".
  useEffect(() => {
    if (user?.appearance.theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => applyAppearanceToDocument(user.appearance);
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [user]);

  if (phase === 'unsupported') {
    return (
      <div className="fatal-screen">
        <div className="fatal-card" role="alert">
          <AlertIcon size={32} />
          <h1 className="fatal-title">WolffMsg cannot run here</h1>
          <p className="fatal-message">{blockingError}</p>
        </div>
      </div>
    );
  }

  /*
   * Each phase animates itself in. There is deliberately no `AnimatePresence`
   * wrapping them: `mode="wait"` holds the incoming screen until the outgoing
   * one reports its exit, and a missed completion callback leaves the app
   * stuck on a faded-out shell with nothing rendered behind it. An entrance
   * animation alone reads the same and cannot deadlock.
   */
  return (
    <>
      {phase === 'booting' ? (
        <motion.div
          key="boot"
          className="boot-screen"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
        >
          <div className="boot-inner">
            <Logo size={56} />
            <Spinner size={20} />
            <p className="boot-label">Unlocking</p>
          </div>
        </motion.div>
      ) : phase === 'signed-out' ? (
        <motion.div
          key="auth"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.24 }}
          style={{ height: '100%' }}
        >
          <AuthScreen />
        </motion.div>
      ) : (
        <motion.div
          key="app"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.28 }}
          style={{ height: '100%' }}
        >
          <AppShell />
        </motion.div>
      )}
      <ToastStack />
    </>
  );
}
