/** Transient interface state: overlays, toasts, and the mobile pane split. */
import { create } from 'zustand';
import type { PlaintextAttachment } from '@wolffmsg/shared';

export type Overlay =
  | { kind: 'none' }
  | { kind: 'command-palette' }
  | { kind: 'new-chat' }
  | { kind: 'new-group' }
  | { kind: 'settings'; section?: SettingsSection }
  | { kind: 'profile'; userId: string }
  | { kind: 'chat-info'; chatId: string }
  | { kind: 'safety-number'; userId: string }
  | { kind: 'search' }
  | { kind: 'forward'; messageId: string }
  | { kind: 'image-viewer'; attachments: PlaintextAttachment[]; index: number };

export type SettingsSection =
  | 'account'
  | 'privacy'
  | 'security'
  | 'notifications'
  | 'appearance'
  | 'devices'
  | 'storage'
  | 'about';

export interface Toast {
  id: string;
  tone: 'info' | 'success' | 'warning' | 'danger';
  message: string;
  /** Optional action rendered alongside the message. */
  action?: { label: string; run: () => void };
}

interface UiState {
  overlay: Overlay;
  toasts: Toast[];
  /** On narrow screens only one pane is visible at a time. */
  mobilePane: 'list' | 'chat';
  replyingTo: string | null;
  editing: string | null;

  openOverlay: (overlay: Overlay) => void;
  closeOverlay: () => void;
  toast: (message: string, tone?: Toast['tone'], action?: Toast['action']) => void;
  dismissToast: (id: string) => void;
  setMobilePane: (pane: 'list' | 'chat') => void;
  setReplyingTo: (messageId: string | null) => void;
  setEditing: (messageId: string | null) => void;
}

let toastSeq = 0;

export const useUi = create<UiState>((set, get) => ({
  overlay: { kind: 'none' },
  toasts: [],
  mobilePane: 'list',
  replyingTo: null,
  editing: null,

  openOverlay: (overlay) => set({ overlay }),
  closeOverlay: () => set({ overlay: { kind: 'none' } }),

  toast: (message, tone = 'info', action) => {
    toastSeq += 1;
    const id = `toast-${toastSeq}`;
    const entry: Toast = { id, tone, message, ...(action ? { action } : {}) };
    set({ toasts: [...get().toasts, entry] });

    // Errors linger; confirmations get out of the way.
    const life = tone === 'danger' ? 8_000 : tone === 'warning' ? 6_000 : 4_000;
    window.setTimeout(() => get().dismissToast(id), life);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setMobilePane: (mobilePane) => set({ mobilePane }),
  setReplyingTo: (replyingTo) => set({ replyingTo, editing: null }),
  setEditing: (editing) => set({ editing, replyingTo: null }),
}));
