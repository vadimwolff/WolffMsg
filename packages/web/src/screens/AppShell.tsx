/**
 * The application shell.
 *
 * Two panes on a desktop, one at a time on a phone. The mobile behaviour is
 * not a narrowed desktop: the list and the thread are separate screens with a
 * real back affordance and a slide transition, because that is what a phone
 * user expects from a messenger.
 */
import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChatList } from './ChatList.tsx';
import { ChatView } from './ChatView.tsx';
import { CommandPalette } from '../components/CommandPalette.tsx';
import { NewChatDialog } from '../components/NewChatDialog.tsx';
import { NewGroupDialog } from '../components/NewGroupDialog.tsx';
import { SettingsDialog } from '../components/settings/SettingsDialog.tsx';
import { ChatInfoDialog } from '../components/ChatInfoDialog.tsx';
import { SafetyNumberDialog } from '../components/SafetyNumberDialog.tsx';
import { ProfileDialog } from '../components/ProfileDialog.tsx';
import { SearchDialog } from '../components/SearchDialog.tsx';
import { ForwardDialog } from '../components/ForwardDialog.tsx';
import { ImageViewer } from '../components/ImageViewer.tsx';
import { CallOverlay } from '../components/CallOverlay.tsx';
import { ConnectionBanner } from '../components/ConnectionBanner.tsx';
import { useChats } from '../store/chats.ts';
import { useSession } from '../store/session.ts';
import { useUi } from '../store/ui.ts';
import { useMediaQuery } from '../hooks/useMediaQuery.ts';

export function AppShell() {
  const loadChats = useChats((s) => s.loadChats);
  const retryOutbox = useChats((s) => s.retryOutbox);
  const activeChatId = useChats((s) => s.activeChatId);
  const overlay = useUi((s) => s.overlay);
  const closeOverlay = useUi((s) => s.closeOverlay);
  const openOverlay = useUi((s) => s.openOverlay);
  const mobilePane = useUi((s) => s.mobilePane);
  const setMobilePane = useUi((s) => s.setMobilePane);
  const isCompact = useMediaQuery('(max-width: 860px)');

  useEffect(() => {
    void loadChats();
    void retryOutbox();
  }, [loadChats, retryOutbox]);

  // Opening a chat on a phone means navigating to it.
  useEffect(() => {
    if (isCompact && activeChatId) setMobilePane('chat');
  }, [activeChatId, isCompact, setMobilePane]);

  /**
   * Global shortcuts.
   *
   * Skipped whenever focus is in a text field, so typing "k" in the composer
   * never opens the palette.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openOverlay({ kind: 'command-palette' });
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !typing) {
        event.preventDefault();
        openOverlay({ kind: 'search' });
        return;
      }
      if (event.key === 'Escape' && useUi.getState().overlay.kind === 'none') {
        if (isCompact && useUi.getState().mobilePane === 'chat') {
          setMobilePane('list');
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openOverlay, isCompact, setMobilePane]);

  // The browser back button should leave the thread, not the app.
  useEffect(() => {
    if (!isCompact) return;
    const onPopState = () => {
      if (useUi.getState().mobilePane === 'chat') setMobilePane('list');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [isCompact, setMobilePane]);

  useEffect(() => {
    if (isCompact && mobilePane === 'chat') {
      history.pushState({ pane: 'chat' }, '');
    }
  }, [isCompact, mobilePane]);

  return (
    <div className="shell" data-compact={isCompact ? 'true' : undefined}>
      <a className="skip-link" href="#thread">
        Skip to conversation
      </a>

      <ConnectionBanner />

      <div className="shell-body">
        <AnimatePresence initial={false}>
          {!isCompact || mobilePane === 'list' ? (
            <motion.aside
              key="sidebar"
              className="sidebar"
              aria-label="Conversations"
              initial={isCompact ? { x: '-100%' } : false}
              animate={isCompact ? { x: 0 } : {}}
              exit={isCompact ? { x: '-100%' } : {}}
              transition={{ type: 'spring', stiffness: 420, damping: 40 }}
            >
              <ChatList />
            </motion.aside>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {!isCompact || mobilePane === 'chat' ? (
            <motion.main
              key="thread"
              id="thread"
              className="thread-pane"
              initial={isCompact ? { x: '100%' } : false}
              animate={isCompact ? { x: 0 } : {}}
              exit={isCompact ? { x: '100%' } : {}}
              transition={{ type: 'spring', stiffness: 420, damping: 40 }}
            >
              <ChatView />
            </motion.main>
          ) : null}
        </AnimatePresence>
      </div>

      <CallOverlay />

      <CommandPalette
        open={overlay.kind === 'command-palette'}
        onClose={closeOverlay}
      />
      <NewChatDialog open={overlay.kind === 'new-chat'} onClose={closeOverlay} />
      <NewGroupDialog open={overlay.kind === 'new-group'} onClose={closeOverlay} />
      <SearchDialog open={overlay.kind === 'search'} onClose={closeOverlay} />
      <SettingsDialog
        open={overlay.kind === 'settings'}
        section={overlay.kind === 'settings' ? overlay.section : undefined}
        onClose={closeOverlay}
      />
      {overlay.kind === 'chat-info' ? (
        <ChatInfoDialog chatId={overlay.chatId} onClose={closeOverlay} />
      ) : null}
      {overlay.kind === 'safety-number' ? (
        <SafetyNumberDialog userId={overlay.userId} onClose={closeOverlay} />
      ) : null}
      {overlay.kind === 'profile' ? (
        <ProfileDialog userId={overlay.userId} onClose={closeOverlay} />
      ) : null}
      {overlay.kind === 'forward' ? (
        <ForwardDialog messageId={overlay.messageId} onClose={closeOverlay} />
      ) : null}
      {overlay.kind === 'image-viewer' ? (
        <ImageViewer
          attachments={overlay.attachments}
          index={overlay.index}
          onClose={closeOverlay}
        />
      ) : null}
    </div>
  );
}

/** Re-exported so screens can read the signed-in user without importing twice. */
export { useSession };
