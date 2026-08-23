/**
 * Realtime events that are about the *account*, not about a conversation.
 *
 * The chat store folds message, typing, presence and chat events into what is
 * on screen. These four are different in kind: they concern this device's keys
 * and this session's validity, and each one is the server telling the client to
 * do something it otherwise would not know to do.
 *
 * Every one of them was, at one point, silently dropped. What that cost:
 *
 *  - `prekeys:low` is the *only* prompt a long-lived session gets to replenish
 *    its one-time prekeys. Ignoring it means the supply runs out, senders fall
 *    back to the signed prekey, and forward secrecy quietly stops applying —
 *    with nothing visible to say so. This is the one that matters most.
 *  - `session:revoked` means the session is already gone server-side. Ignoring
 *    it left a signed-out device still showing decrypted messages until its
 *    next HTTP call happened to 401.
 *  - `identity:changed` is the whole point of pinning identity keys: it says a
 *    peer's device key is not the one you verified. It has to be seen *now*,
 *    not on the next reload.
 *  - `contact:update` needs nothing here, and the reason is worth recording so
 *    the next person does not add a handler that does nothing: there is no
 *    cached contact state to invalidate. Every screen that shows verification
 *    state fetches `/api/contacts` when it opens, so it is already current.
 */
import { realtime } from './socket.ts';
import { useSession } from '../store/session.ts';
import { useChats } from '../store/chats.ts';
import { useUi } from '../store/ui.ts';
import {
  resetKeyMaintenanceThrottled,
  runKeyMaintenanceThrottled,
} from '../crypto/session.ts';
import { detach } from './async.ts';

export function connectSystemEvents(): () => void {
  /*
   * Called once per signed-in session, from the one effect in App that owns
   * the socket subscriptions — which is why the throttle is cleared here
   * rather than at each of the five places a session can begin. A new session
   * must never have its first `prekeys:low` swallowed by the previous one's
   * cooldown.
   */
  resetKeyMaintenanceThrottled();

  return realtime.on((event) => {
    switch (event.t) {
      case 'prekeys:low': {
        detach(runKeyMaintenanceThrottled());
        return;
      }

      case 'session:revoked': {
        // Already invalid server-side; there is nothing to log out *from*, and
        // this device must stop showing decrypted content immediately.
        detach(useSession.getState().handleRevoked(event.reason));
        return;
      }

      case 'identity:changed': {
        const who = useChats.getState().people[event.userId];
        const name = who?.displayName ?? who?.username ?? 'A contact';
        useUi
          .getState()
          .toast(
            `${name}'s security code changed. Verify it before sending anything sensitive.`,
            'warning',
          );
        return;
      }

      default:
        return;
    }
  });
}
