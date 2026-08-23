/**
 * Choose a server.
 *
 * Shown when this client is served from somewhere that has no WolffMsg API
 * behind it — a static host such as GitHub Pages. The alternative would be a
 * sign-in form whose every button fails, or a canned demo account; neither is
 * honest, so the app says what it needs instead.
 *
 * The client is the whole security-critical half of WolffMsg: keys are made
 * here, messages are encrypted here, and the server only ever relays
 * ciphertext. Pointing this build at your own server is therefore a real
 * deployment, not a preview of one.
 */
import { useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { useSession } from '../store/session.ts';
import { describeOriginProblem } from '../lib/serverOrigin.ts';
import { LogoHero } from '../components/Logo.tsx';
import { Button, Field } from '../components/primitives.tsx';
import { AlertIcon, KeyIcon, ServerIcon, ShieldCheckIcon } from '../components/icons.tsx';

export function ConnectServerScreen() {
  const connectToServer = useSession((s) => s.connectToServer);

  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;

    const problem = describeOriginProblem(address);
    if (problem) {
      setError(problem);
      return;
    }

    setError(null);
    setBusy(true);
    try {
      await connectToServer(address);
    } catch (err) {
      setError((err as Error).message || 'Could not reach that server');
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <motion.div
        className="auth-card connect-card"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      >
        <header className="auth-header">
          <LogoHero size={84} />
          <h1 className="auth-wordmark">
            WOLFF<span className="auth-wordmark-accent">MSG</span>
          </h1>
          <p className="auth-tagline">Private communication.</p>
        </header>

        <div className="connect-notice" role="note">
          <AlertIcon size={16} />
          <p>
            This page is a static build with no server behind it. Enter the address
            of a WolffMsg server to use it — there is no shared or demo server, by
            design.
          </p>
        </div>

        <form className="auth-form" onSubmit={submit} noValidate>
          <Field
            label="Server address"
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder="https://chat.example.com"
            hint="HTTPS only. The browser will not expose the crypto this app needs on an insecure origin."
            value={address}
            error={error}
            disabled={busy}
            onChange={(event) => {
              setAddress(event.target.value);
              if (error) setError(null);
            }}
          />

          <Button type="submit" variant="primary" size="lg" fullWidth loading={busy}>
            {busy ? 'Connecting' : 'Connect'}
          </Button>
        </form>

        <section className="connect-explainer">
          <h2 className="connect-explainer-title">Why there is no demo server</h2>
          <p>
            Every message is encrypted on the device that sends it and decrypted
            only on the devices that receive it. A server run by someone else
            would still hold your account, your contact graph and your delivery
            metadata — so WolffMsg asks you to bring your own rather than quietly
            handing that to a stranger.
          </p>
          <p>
            Running one takes Docker and a few minutes; the repository has the
            compose file and the deployment guide.
          </p>
        </section>

        <footer className="auth-assurances">
          <span className="auth-assurance">
            <KeyIcon size={14} /> Keys stay on this device
          </span>
          <span className="auth-assurance">
            <ShieldCheckIcon size={14} /> Server sees ciphertext
          </span>
          <span className="auth-assurance">
            <ServerIcon size={14} /> Self-hosted
          </span>
        </footer>
      </motion.div>
    </div>
  );
}
