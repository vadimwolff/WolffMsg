import { AnimatePresence, motion } from 'framer-motion';
import { useChats } from '../store/chats.ts';
import { useSession } from '../store/session.ts';
import { OfflineIcon } from './icons.tsx';
import { Spinner } from './primitives.tsx';

/**
 * The connection state strip.
 *
 * Deliberately absent while everything is fine — a permanent "connected"
 * badge is noise. It appears only when something needs saying, and it says
 * what it means for the person: queued messages will send themselves.
 */
export function ConnectionBanner() {
  const connection = useSession((s) => s.connection);
  const queued = useChats((s) => s.outbox.length);

  const offline = connection === 'offline';
  const reconnecting = connection === 'reconnecting' || connection === 'connecting';
  const show = offline || reconnecting;

  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          className="connection-banner"
          data-state={offline ? 'offline' : 'reconnecting'}
          role="status"
          aria-live="polite"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          <span className="connection-banner-inner">
            {offline ? <OfflineIcon size={15} /> : <Spinner size={14} />}
            <span>
              {offline ? 'Offline' : 'Reconnecting…'}
              {queued > 0 ? (
                <span className="connection-banner-queue">
                  {' · '}
                  {queued} message{queued === 1 ? '' : 's'} waiting to send
                </span>
              ) : null}
            </span>
          </span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
