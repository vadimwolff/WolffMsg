import { useEffect, useState } from 'react';
import { api } from '../../lib/api.ts';
import { useUi } from '../../store/ui.ts';
import { Button, Skeleton } from '../primitives.tsx';
import { DatabaseIcon, TrashIcon } from '../icons.tsx';
import { formatBytes, releaseAllAttachments } from '../../crypto/attachments.ts';
import { STORE_MESSAGES, idbClear } from '../../lib/idb.ts';
import { clearMemory } from '../../crypto/messageCache.ts';
import { onAsync } from '../../lib/async.ts';

interface Usage {
  attachmentBytes: number;
  attachmentCount: number;
  messageCount: number;
  chatCount: number;
}

export function StorageSection() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [local, setLocal] = useState<{ usage: number; quota: number } | null>(null);
  const [clearing, setClearing] = useState(false);
  const toast = useUi((s) => s.toast);

  useEffect(() => {
    void api
      .get<Usage>('/api/me/storage')
      .then(setUsage)
      .catch(() => undefined);

    void navigator.storage
      ?.estimate?.()
      .then((estimate) =>
        setLocal({ usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }),
      )
      .catch(() => undefined);
  }, []);

  return (
    <div className="settings-section">
      <h3 className="settings-title">Storage</h3>

      <section className="settings-block">
        <h4 className="settings-subtitle">On the server</h4>
        {!usage ? (
          <Skeleton height={72} radius={12} />
        ) : (
          <div className="usage-grid">
            <div className="usage-card">
              <span className="usage-value">{formatBytes(usage.attachmentBytes)}</span>
              <span className="usage-label">Encrypted attachments</span>
            </div>
            <div className="usage-card">
              <span className="usage-value">{usage.attachmentCount}</span>
              <span className="usage-label">Files</span>
            </div>
            <div className="usage-card">
              <span className="usage-value">{usage.messageCount}</span>
              <span className="usage-label">Messages sent</span>
            </div>
            <div className="usage-card">
              <span className="usage-value">{usage.chatCount}</span>
              <span className="usage-label">Conversations</span>
            </div>
          </div>
        )}
        <p className="settings-hint">
          Everything above is stored as ciphertext. The byte count is the size of
          the encrypted blobs, not of anything readable.
        </p>
      </section>

      <section className="settings-block">
        <h4 className="settings-subtitle">On this device</h4>
        {local ? (
          <>
            <div className="storage-bar" aria-hidden="true">
              <span
                className="storage-bar-fill"
                style={{
                  width: `${Math.min(100, local.quota ? (local.usage / local.quota) * 100 : 0)}%`,
                }}
              />
            </div>
            <p className="settings-hint">
              {formatBytes(local.usage)} used
              {local.quota ? ` of about ${formatBytes(local.quota)} available` : ''}.
            </p>
          </>
        ) : (
          <p className="settings-hint">
            This browser does not report a storage estimate.
          </p>
        )}

        <div className="notice" data-tone="accent">
          <DatabaseIcon size={16} />
          <div>
            <strong>What is cached here</strong>
            <p>
              Decrypted message text, so search works without the server, plus your
              device keys — sealed under a key this browser will not let a script
              read.
            </p>
          </div>
        </div>

        <Button
          variant="danger"
          icon={<TrashIcon size={16} />}
          loading={clearing}
          onClick={onAsync(async () => {
            setClearing(true);
            try {
              releaseAllAttachments();
              clearMemory();
              await idbClear(STORE_MESSAGES);
              toast(
                'Local message cache cleared. Search will find nothing until history is re-opened.',
                'success',
              );
            } catch {
              toast('Could not clear the cache', 'danger');
            } finally {
              setClearing(false);
            }
          })}
        >
          Clear local message cache
        </Button>
        <p className="settings-hint">
          Your keys are kept. Messages stay on the server and will be decrypted
          again as you scroll back through them.
        </p>
      </section>
    </div>
  );
}
