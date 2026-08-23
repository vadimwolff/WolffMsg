import { useState } from 'react';
import { Logo } from '../Logo.tsx';
import { Badge, Button } from '../primitives.tsx';
import { LockIcon, ServerIcon } from '../icons.tsx';
import { useSession } from '../../store/session.ts';

/**
 * About.
 *
 * Deliberately specific about the cryptography rather than reassuring about
 * it. A user who wants to check our claims should be able to start here.
 */
export function AboutSection() {
  return (
    <div className="settings-section">
      <div className="about-head">
        <Logo size={56} />
        <div>
          <h3 className="settings-title" style={{ margin: 0 }}>
            WOLFF<span className="logo-wordmark-accent">MSG</span>
          </h3>
          <p className="settings-hint" style={{ margin: 0 }}>
            Private communication.
          </p>
        </div>
      </div>

      <section className="settings-block">
        <h4 className="settings-subtitle">How your messages are protected</h4>
        <ul className="about-list">
          <li>
            <strong>Message bodies</strong> are encrypted with
            XChaCha20-Poly1305 under a fresh random key per message.
          </li>
          <li>
            <strong>That key</strong> is sealed to each recipient device with an
            X25519 sealed box, using a one-time prekey wherever one is available.
          </li>
          <li>
            <strong>Authenticity</strong> comes from an Ed25519 signature by the
            sending device, checked against the key you have pinned for it.
          </li>
          <li>
            <strong>Files</strong> are encrypted on your device with the
            XChaCha20-Poly1305 secretstream construction before upload.
          </li>
          <li>
            <strong>Your password</strong> is stored only as an Argon2id hash.
          </li>
        </ul>
        <p className="settings-hint">
          All of these come from libsodium. WolffMsg implements no cryptographic
          primitive of its own.
        </p>
      </section>

      <section className="settings-block">
        <h4 className="settings-subtitle">What the server can still see</h4>
        <ul className="about-list">
          <li>Who talks to whom, and when.</li>
          <li>Message sizes, and which devices a message was addressed to.</li>
          <li>Group membership and group names.</li>
          <li>Reaction emoji, which are stored unencrypted.</li>
        </ul>
        <p className="settings-hint">
          Encryption protects content, not the fact that you communicated.
          SECURITY.md in the repository sets out the full list and the known
          limits.
        </p>
      </section>

      <section className="settings-block">
        <div className="notice" data-tone="accent">
          <LockIcon size={16} />
          <div>
            <strong>No system is “100% secure”</strong>
            <p>
              WolffMsg does not implement the Signal Double Ratchet, so it does
              not offer post-compromise recovery. Forward secrecy holds while
              one-time prekeys are available. These trade-offs are documented
              rather than hidden.
            </p>
          </div>
        </div>
      </section>

      <ConnectedServer />

      <section className="settings-block">
        <div className="about-meta">
          <Badge tone="accent">Protocol v1</Badge>
          <Badge>libsodium</Badge>
          <Badge>AGPL-3.0</Badge>
        </div>
      </section>
    </div>
  );
}

/**
 * Which server this client is talking to.
 *
 * Only meaningful when the client was served from somewhere else — a static
 * host pointed at a self-hosted server. In the ordinary deployment the server
 * serves this page, so naming its own address would be noise.
 */
function ConnectedServer() {
  const origin = useSession((s) => s.serverOrigin);
  const forgetServer = useSession((s) => s.forgetServer);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!origin) return null;

  return (
    <section className="settings-block">
      <h4 className="settings-subtitle">Connected server</h4>
      <p className="connect-current">
        <ServerIcon size={14} />
        <span>{origin}</span>
      </p>
      <p className="settings-hint">
        This client was served separately from the server it talks to. Switching
        servers erases this device's keys and its decrypted message cache, exactly
        as signing out does — the keys are registered with one server only.
      </p>
      {confirming ? (
        <div className="settings-actions">
          <Button
            variant="danger"
            loading={busy}
            onClick={() => {
              setBusy(true);
              void forgetServer();
            }}
          >
            Erase keys and disconnect
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="settings-actions">
          <Button onClick={() => setConfirming(true)}>Switch server</Button>
        </div>
      )}
    </section>
  );
}
