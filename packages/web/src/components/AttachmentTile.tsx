/**
 * An attachment inside a bubble.
 *
 * Nothing is fetched until the tile is on screen: an intersection observer
 * triggers the download-and-decrypt, so opening a thread with fifty photos
 * does not immediately pull fifty encrypted blobs.
 */
import { useEffect, useRef, useState } from 'react';
import type { PlaintextAttachment } from '@wolffmsg/shared';
import { formatBytes, openAttachment, saveAttachment } from '../crypto/attachments.ts';
import { AlertIcon, DownloadIcon, PlayIcon } from './icons.tsx';
import { Spinner } from './primitives.tsx';
import { useUi } from '../store/ui.ts';
import { onAsync } from '../lib/async.ts';

interface Props {
  attachment: PlaintextAttachment;
  variant?: 'media' | 'file';
  onOpen?: () => void;
}

export function AttachmentTile({ attachment, variant = 'media', onOpen }: Props) {
  if (variant === 'file' || !isPreviewable(attachment.mimeType)) {
    return <FileTile attachment={attachment} />;
  }
  return <MediaTile attachment={attachment} onOpen={onOpen} />;
}

function isPreviewable(mimeType: string): boolean {
  return mimeType.startsWith('image/') || mimeType.startsWith('video/');
}

function MediaTile({
  attachment,
  onOpen,
}: {
  attachment: PlaintextAttachment;
  onOpen?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const toast = useUi((s) => s.toast);

  useEffect(() => {
    const node = ref.current;
    if (!node || state !== 'idle') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setState('loading');
        openAttachment(attachment)
          .then((objectUrl) => {
            setUrl(objectUrl);
            setState('ready');
          })
          .catch(() => setState('error'));
      },
      // Start a little before it scrolls in, so it is usually ready on arrival.
      { rootMargin: '250px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [attachment, state]);

  const isVideo = attachment.mimeType.startsWith('video/');
  const ratio =
    attachment.width && attachment.height
      ? attachment.width / attachment.height
      : 4 / 3;

  return (
    <div
      ref={ref}
      className="media-tile"
      style={{ aspectRatio: String(Math.min(Math.max(ratio, 0.6), 2.2)) }}
    >
      {state === 'ready' && url ? (
        isVideo ? (
          <video
            src={url}
            className="media-tile-content"
            controls
            preload="metadata"
            playsInline
          />
        ) : (
          <button
            type="button"
            className="media-tile-button"
            onClick={onOpen}
            aria-label={`Open ${attachment.name}`}
          >
            <img
              src={url}
              alt={attachment.name}
              className="media-tile-content"
              loading="lazy"
              decoding="async"
            />
          </button>
        )
      ) : state === 'error' ? (
        <div className="media-tile-state" data-tone="danger">
          <AlertIcon size={18} />
          <span>Could not open</span>
          <button
            type="button"
            className="media-tile-retry"
            onClick={() => setState('idle')}
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="media-tile-state">
          {state === 'loading' ? <Spinner size={18} /> : <PlayIcon size={18} />}
          <span className="sr-only">Decrypting attachment</span>
        </div>
      )}

      {state === 'ready' ? (
        <button
          type="button"
          className="media-tile-save"
          aria-label={`Save ${attachment.name}`}
          onClick={(event) => {
            event.stopPropagation();
            void saveAttachment(attachment).catch(() =>
              toast('Could not save that file', 'danger'),
            );
          }}
        >
          <DownloadIcon size={15} />
        </button>
      ) : null}
    </div>
  );
}

function FileTile({ attachment }: { attachment: PlaintextAttachment }) {
  const [busy, setBusy] = useState(false);
  const toast = useUi((s) => s.toast);

  return (
    <button
      type="button"
      className="file-tile"
      onClick={onAsync(async () => {
        setBusy(true);
        try {
          await saveAttachment(attachment);
        } catch {
          toast('Could not open that file', 'danger');
        } finally {
          setBusy(false);
        }
      })}
    >
      <span className="file-tile-icon">
        {busy ? <Spinner size={16} /> : <DownloadIcon size={17} />}
      </span>
      <span className="file-tile-body">
        <span className="file-tile-name">{attachment.name}</span>
        <span className="file-tile-size">{formatBytes(attachment.size)}</span>
      </span>
    </button>
  );
}
