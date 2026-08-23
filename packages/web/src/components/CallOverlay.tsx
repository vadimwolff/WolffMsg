/**
 * The in-call surface.
 *
 * A full-screen overlay for video, a compact panel for voice. Streams are
 * attached imperatively via refs because a `MediaStream` is not a value React
 * can render.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Avatar } from './Avatar.tsx';
import { IconButton } from './primitives.tsx';
import {
  LockIcon,
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
  VideoIcon,
} from './icons.tsx';
import { useCalls, connectCallEvents } from '../store/calls.ts';
import { formatDuration } from '../lib/format.ts';

export function CallOverlay() {
  const phase = useCalls((s) => s.phase);
  const peer = useCalls((s) => s.peer);
  const kind = useCalls((s) => s.kind);
  const localStream = useCalls((s) => s.localStream);
  const remoteStream = useCalls((s) => s.remoteStream);
  const micEnabled = useCalls((s) => s.micEnabled);
  const cameraEnabled = useCalls((s) => s.cameraEnabled);
  const connectionState = useCalls((s) => s.connectionState);
  const error = useCalls((s) => s.error);
  const startedAt = useCalls((s) => s.startedAt);

  const accept = useCalls((s) => s.accept);
  const decline = useCalls((s) => s.decline);
  const hangUp = useCalls((s) => s.hangUp);
  const toggleMic = useCalls((s) => s.toggleMic);
  const toggleCamera = useCalls((s) => s.toggleCamera);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => connectCallEvents(), []);

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
    // A voice call still needs an audio sink, and it must not be the video
    // element (which is not rendered at all in that case).
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  useEffect(() => {
    if (phase !== 'active' || !startedAt) return;
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 500);
    return () => window.clearInterval(timer);
  }, [phase, startedAt]);

  if (phase === 'idle') return null;

  const isVideo = kind === 'video';
  const name = peer?.displayName ?? 'Calling…';

  const statusLine =
    error ??
    (phase === 'ringing-in'
      ? `Incoming ${isVideo ? 'video ' : ''}call`
      : phase === 'ringing-out'
        ? 'Ringing…'
        : phase === 'connecting'
          ? connectionState === 'connecting'
            ? 'Connecting…'
            : 'Establishing an encrypted connection…'
          : phase === 'ended'
            ? 'Call ended'
            : formatDuration(elapsed));

  return (
    <AnimatePresence>
      <motion.div
        className="call-overlay"
        data-video={isVideo && phase === 'active' ? 'true' : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={`${isVideo ? 'Video' : 'Voice'} call with ${name}`}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 16 }}
        transition={{ type: 'spring', stiffness: 340, damping: 32 }}
      >
        {isVideo && remoteStream && phase === 'active' ? (
          <video
            ref={remoteVideoRef}
            className="call-remote-video"
            autoPlay
            playsInline
          />
        ) : (
          <div className="call-portrait">
            <Avatar
              userId={peer?.id ?? 'unknown'}
              name={name}
              url={peer?.avatarUrl ?? null}
              size={112}
              shape="circle"
            />
          </div>
        )}

        {/* Audio sink — always present, so a voice call is audible. */}
        <audio ref={remoteAudioRef} autoPlay className="sr-only" />

        <div className="call-info">
          <h2 className="call-name">{name}</h2>
          <p className="call-status" data-error={error ? 'true' : undefined}>
            {statusLine}
          </p>
          {phase === 'active' ? (
            <p className="call-encryption">
              <LockIcon size={12} />
              Media is encrypted peer-to-peer
            </p>
          ) : null}
        </div>

        {isVideo && localStream ? (
          <video
            ref={localVideoRef}
            className="call-local-video"
            autoPlay
            playsInline
            muted
            data-hidden={!cameraEnabled || undefined}
          />
        ) : null}

        <div className="call-controls">
          {phase === 'ringing-in' ? (
            <>
              <IconButton
                label="Decline call"
                variant="danger"
                size="lg"
                onClick={decline}
              >
                <PhoneOffIcon />
              </IconButton>
              <IconButton
                label="Answer call"
                variant="primary"
                size="lg"
                onClick={() => void accept()}
              >
                <PhoneIcon />
              </IconButton>
            </>
          ) : (
            <>
              <IconButton
                label={micEnabled ? 'Mute microphone' : 'Unmute microphone'}
                active={!micEnabled}
                size="lg"
                onClick={toggleMic}
              >
                {micEnabled ? <MicIcon /> : <MicOffIcon />}
              </IconButton>

              {isVideo ? (
                <IconButton
                  label={cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
                  active={!cameraEnabled}
                  size="lg"
                  onClick={toggleCamera}
                >
                  <VideoIcon />
                </IconButton>
              ) : null}

              <IconButton
                label="End call"
                variant="danger"
                size="lg"
                onClick={hangUp}
              >
                <PhoneOffIcon />
              </IconButton>
            </>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
