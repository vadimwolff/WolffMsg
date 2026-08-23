/**
 * Sign in and sign up.
 *
 * The first thing a person sees, so it carries the whole visual argument: the
 * mark, the promise, and nothing else competing for attention. Key generation
 * happens here too — the progress line during sign-up is real work, not a
 * decorative delay.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  LIMITS,
  normalizeUsername,
  passwordStrength,
  validateDisplayName,
  validatePassword,
  validateUsername,
} from '@wolffmsg/shared';
import { ApiError, NetworkError, api } from '../lib/api.ts';
import { useSession } from '../store/session.ts';
import { LogoHero } from '../components/Logo.tsx';
import { Button, Field } from '../components/primitives.tsx';
import { LockIcon, ShieldCheckIcon, KeyIcon } from '../components/icons.tsx';
import { onAsync } from '../lib/async.ts';

type Mode = 'signin' | 'signup';

const STRENGTH_LABELS = ['Too weak', 'Weak', 'Fair', 'Strong', 'Excellent'];

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('signin');
  const register = useSession((s) => s.register);
  const signIn = useSession((s) => s.signIn);
  const config = useSession((s) => s.config);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [availability, setAvailability] = useState<
    { checking: boolean; available: boolean | null; reason: string | null }
  >({ checking: false, available: null, reason: null });

  const usernameRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    usernameRef.current?.focus();
  }, [mode]);

  /** Debounced availability check, so the field answers before submit does. */
  useEffect(() => {
    if (mode !== 'signup') return;
    const candidate = normalizeUsername(username);
    if (validateUsername(candidate)) {
      setAvailability({ checking: false, available: null, reason: null });
      return;
    }

    setAvailability((prev) => ({ ...prev, checking: true }));
    const timer = window.setTimeout(onAsync(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await api.get<{ available: boolean; reason: string | null }>(
          `/api/auth/username-available?username=${encodeURIComponent(candidate)}`,
          controller.signal,
        );
        setAvailability({
          checking: false,
          available: result.available,
          reason: result.reason,
        });
      } catch {
        setAvailability({ checking: false, available: null, reason: null });
      }
    }), 400);

    return () => window.clearTimeout(timer);
  }, [username, mode]);

  const strength = passwordStrength(password);

  function validate(): boolean {
    const next: Record<string, string> = {};
    const cleanUsername = normalizeUsername(username);

    const usernameProblem = validateUsername(cleanUsername);
    if (usernameProblem) next.username = usernameProblem.message;

    if (mode === 'signup') {
      const passwordProblem = validatePassword(password);
      if (passwordProblem) next.password = passwordProblem.message;

      const nameProblem = validateDisplayName(displayName);
      if (nameProblem) next.displayName = nameProblem.message;

      if (password !== confirm) next.confirm = 'Those passwords do not match';
      if (availability.available === false) {
        next.username = availability.reason ?? 'That username is taken';
      }
    } else if (!password) {
      next.password = 'Password is required';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (!validate()) return;

    setBusy(true);
    try {
      if (mode === 'signup') {
        // Generating 100 prekeys plus an identity takes a visible moment; say
        // what is happening rather than showing an unexplained pause.
        setStage('Generating your encryption keys on this device…');
        await register({
          username: normalizeUsername(username),
          password,
          displayName: displayName.trim(),
        });
      } else {
        setStage('Unlocking this device…');
        await signIn({ username: normalizeUsername(username), password });
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) setErrors(err.fields);
        setFormError(err.fields ? null : err.message);
      } else if (err instanceof NetworkError) {
        setFormError('Cannot reach the server. Check your connection.');
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setErrors({});
    setFormError(null);
    setPassword('');
    setConfirm('');
  }

  const registrationClosed = config?.registrationOpen === false;

  return (
    <div className="auth-screen">
      <motion.main
        className="auth-card"
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      >
        <header className="auth-header">
          <LogoHero size={84} />
          <h1 className="auth-wordmark">
            WOLFF<span className="auth-wordmark-accent">MSG</span>
          </h1>
          <p className="auth-tagline">Private communication.</p>
        </header>

        <div className="auth-tabs" role="tablist" aria-label="Sign in or create an account">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signin'}
            className="auth-tab"
            data-active={mode === 'signin' ? 'true' : undefined}
            onClick={() => switchMode('signin')}
          >
            {mode === 'signin' ? (
              <motion.span layoutId="auth-tab-indicator" className="auth-tab-indicator" />
            ) : null}
            <span>Sign in</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signup'}
            className="auth-tab"
            data-active={mode === 'signup' ? 'true' : undefined}
            disabled={registrationClosed}
            title={registrationClosed ? 'Registration is closed on this server' : undefined}
            onClick={() => switchMode('signup')}
          >
            {mode === 'signup' ? (
              <motion.span layoutId="auth-tab-indicator" className="auth-tab-indicator" />
            ) : null}
            <span>Create account</span>
          </button>
        </div>

        <form className="auth-form" onSubmit={onAsync(submit)} noValidate>
          <Field
            ref={usernameRef}
            label="Username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            maxLength={LIMITS.usernameMax}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            error={errors.username ?? null}
            hint={
              mode === 'signup'
                ? availability.available === true
                  ? '✓ Available'
                  : 'Lowercase letters, digits and underscores'
                : undefined
            }
            trailing={
              mode === 'signup' && availability.checking ? (
                <span className="field-spinner" aria-hidden="true" />
              ) : null
            }
          />

          <AnimatePresence initial={false}>
            {mode === 'signup' ? (
              <motion.div
                key="displayName"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                style={{ overflow: 'hidden' }}
              >
                <Field
                  label="Display name"
                  name="displayName"
                  autoComplete="nickname"
                  maxLength={LIMITS.displayNameMax}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  error={errors.displayName ?? null}
                  hint="What people will see. You can change it later."
                />
              </motion.div>
            ) : null}
          </AnimatePresence>

          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            maxLength={LIMITS.passwordMax}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={errors.password ?? null}
          />

          <AnimatePresence initial={false}>
            {mode === 'signup' ? (
              <motion.div
                key="signup-extras"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                style={{ overflow: 'hidden' }}
              >
                {password ? (
                  <div className="strength">
                    <div className="strength-track" aria-hidden="true">
                      {[0, 1, 2, 3].map((i) => (
                        <span
                          key={i}
                          className="strength-segment"
                          data-filled={i < strength ? 'true' : undefined}
                          data-level={strength}
                        />
                      ))}
                    </div>
                    <span className="strength-label" data-level={strength}>
                      {STRENGTH_LABELS[strength]}
                    </span>
                  </div>
                ) : null}

                <Field
                  label="Confirm password"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  error={errors.confirm ?? null}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>

          {formError ? (
            <motion.p
              className="auth-error"
              role="alert"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
            >
              {formError}
            </motion.p>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            loading={busy}
            disabled={registrationClosed && mode === 'signup'}
          >
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          </Button>

          <AnimatePresence>
            {stage ? (
              <motion.p
                className="auth-stage"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                aria-live="polite"
              >
                <KeyIcon size={14} />
                {stage}
              </motion.p>
            ) : null}
          </AnimatePresence>
        </form>

        <footer className="auth-assurances">
          <span className="auth-assurance">
            <LockIcon size={14} />
            End-to-end encrypted
          </span>
          <span className="auth-assurance">
            <ShieldCheckIcon size={14} />
            Keys stay on your device
          </span>
        </footer>

        {registrationClosed && mode === 'signin' ? (
          <p className="auth-note">This server is not accepting new accounts.</p>
        ) : null}
      </motion.main>
    </div>
  );
}
