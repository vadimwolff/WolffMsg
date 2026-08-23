import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing from the document');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * Register the service worker.
 *
 * It provides the offline shell and handles push notifications. Registration
 * failure is never fatal — the app works without it, just without offline
 * support.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    // `BASE_URL` is `/` for the usual deployment and `/<repo>/` when the client
    // is published under a subpath. The worker derives its own scope from where
    // it was served, so these two must agree.
    const base = import.meta.env.BASE_URL;
    void navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .catch(() => {
        /* offline shell unavailable; the app still runs */
      });
  });
}
