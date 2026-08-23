/**
 * Fullscreen image viewer.
 *
 * Zoom with the wheel or pinch, pan by dragging, swipe (or arrow-key) between
 * images. Everything shown here was decrypted locally — the object URLs never
 * leave the tab.
 */
import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { PlaintextAttachment } from '@wolffmsg/shared';
import { openAttachment, saveAttachment } from '../crypto/attachments.ts';
import { IconButton, Spinner } from './primitives.tsx';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  DownloadIcon,
} from './icons.tsx';
import { useUi } from '../store/ui.ts';

export function ImageViewer({
  attachments,
  index: initialIndex,
  onClose,
}: {
  attachments: PlaintextAttachment[];
  index: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(initialIndex);
  const [url, setUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const toast = useUi((s) => s.toast);

  const current = attachments[index];

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    if (!current) return;

    openAttachment(current)
      .then((objectUrl) => {
        if (!cancelled) setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) toast('Could not open that image', 'danger');
      });

    return () => {
      cancelled = true;
    };
  }, [current, toast]);

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => (i + delta + attachments.length) % attachments.length);
    },
    [attachments.length],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') go(1);
      if (event.key === 'ArrowLeft') go(-1);
      if (event.key === '0') {
        setZoom(1);
        setOffset({ x: 0, y: 0 });
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [go, onClose]);

  if (!current) return null;

  return (
    <AnimatePresence>
      <motion.div
        key="viewer"
        className="viewer"
        role="dialog"
        aria-modal="true"
        aria-label={current.name}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <header className="viewer-bar">
          <span className="viewer-name">{current.name}</span>
          <span className="viewer-counter">
            {attachments.length > 1 ? `${index + 1} / ${attachments.length}` : ''}
          </span>
          <div className="viewer-actions">
            <IconButton
              label="Save image"
              onClick={() =>
                void saveAttachment(current).catch(() =>
                  toast('Could not save that image', 'danger'),
                )
              }
            >
              <DownloadIcon />
            </IconButton>
            <IconButton label="Close viewer" onClick={onClose}>
              <CloseIcon />
            </IconButton>
          </div>
        </header>

        <div
          className="viewer-stage"
          onWheel={(event) => {
            if (!event.ctrlKey && Math.abs(event.deltaY) < 4) return;
            setZoom((z) => Math.min(6, Math.max(1, z - event.deltaY * 0.002)));
          }}
        >
          {url ? (
            <motion.img
              key={current.id}
              src={url}
              alt={current.name}
              className="viewer-image"
              drag={zoom > 1}
              dragMomentum={false}
              dragElastic={0.05}
              style={{ scale: zoom, x: offset.x, y: offset.y }}
              onDoubleClick={() => {
                setZoom((z) => (z > 1 ? 1 : 2.4));
                setOffset({ x: 0, y: 0 });
              }}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: zoom }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              // Swipe between images when not zoomed in.
              onDragEnd={(_, info) => {
                if (zoom > 1) return;
                if (info.offset.x < -80) go(1);
                if (info.offset.x > 80) go(-1);
              }}
            />
          ) : (
            <div className="viewer-loading">
              <Spinner size={24} />
              <span>Decrypting…</span>
            </div>
          )}
        </div>

        {attachments.length > 1 ? (
          <>
            <button
              type="button"
              className="viewer-nav"
              data-side="left"
              onClick={() => go(-1)}
              aria-label="Previous image"
            >
              <ChevronLeftIcon size={22} />
            </button>
            <button
              type="button"
              className="viewer-nav"
              data-side="right"
              onClick={() => go(1)}
              aria-label="Next image"
            >
              <ChevronRightIcon size={22} />
            </button>
          </>
        ) : null}
      </motion.div>
    </AnimatePresence>
  );
}
