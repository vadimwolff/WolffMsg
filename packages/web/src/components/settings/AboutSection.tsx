import { Logo } from '../Logo.tsx';
import { Badge } from '../primitives.tsx';
import { LockIcon } from '../icons.tsx';

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
