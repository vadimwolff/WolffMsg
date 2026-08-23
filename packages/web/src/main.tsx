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
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      /* offline shell unavailable; the app still runs */
    });
  });
}
