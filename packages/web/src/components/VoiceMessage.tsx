/**
 * Voice message playback.
 *
 * The waveform is computed on the sending device and travels inside the
 * encrypted body, so it can be drawn immediately — before the audio itself is
 * downloaded and decrypted. Bars fill as playback progresses, and clicking a
 * bar seeks.
 */
import { useEffect, useRef, useState } from 'react';
import type { PlaintextAttachment } from '@wolffmsg/shared';
import { openAttachment } from '../crypto/attachments.ts';
import { PauseIcon, PlayIcon } from './icons.tsx';
import { Spinner } from './primitives.tsx';
import { formatDuration } from '../lib/format.ts';
import { onAsync } from '../lib/async.ts';

interface Props {
  voice: { durationMs: number; waveform: number[] };
  attachment: PlaintextAttachment | undefined;
  mine: boolean;
}

export function VoiceMessage({ voice, attachment, mine }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);

  const progress = voice.durationMs > 0 ? position / voice.durationMs : 0;

  async function toggle() {
    if (!attachment) return;

    if (!url) {
      setLoading(true);
      try {
        const objectUrl = await openAttachment(attachment);
        setUrl(objectUrl);
        // The <audio> element mounts with this src on the next render, so
        // playback starts from the effect below rather than here.
      } finally {
        setLoading(false);
      }
      return;
    }

    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      void audio.play();
    }
  }

  useEffect(() => {
    if (!url) return;
    const audio = audioRef.current;
    if (!audio) return;
    void audio.play().catch(() => undefined);
  }, [url]);

  function seek(fraction: number) {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = audio.duration * fraction;
    setPosition(audio.duration * fraction * 1000);
  }

  return (
    <div className="voice" data-mine={mine || undefined}>
      <button
        type="button"
        className="voice-button"
        onClick={onAsync(toggle)}
        disabled={!attachment}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
      >
        {loading ? (
          <Spinner size={16} />
        ) : playing ? (
          <PauseIcon size={16} />
        ) : (
          <PlayIcon size={16} />
        )}
      </button>

      <div
        className="voice-wave"
        role="slider"
        tabIndex={0}
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') seek(Math.min(1, progress + 0.05));
          if (event.key === 'ArrowLeft') seek(Math.max(0, progress - 0.05));
        }}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          seek((event.clientX - rect.left) / rect.width);
        }}
      >
        {voice.waveform.map((amplitude, index) => {
          const filled = index / voice.waveform.length <= progress;
          return (
            <span
              key={index}
              className="voice-bar"
              data-filled={filled || undefined}
              // A floor of 12% keeps silent passages visible as a line rather
              // than vanishing entirely.
              style={{ height: `${Math.max(12, amplitude * 100)}%` }}
            />
          );
        })}
      </div>

      <span className="voice-time">
        {formatDuration(playing || position > 0 ? position : voice.durationMs)}
      </span>

      {url ? (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPosition(0);
          }}
          onTimeUpdate={(event) =>
            setPosition(event.currentTarget.currentTime * 1000)
          }
        />
      ) : null}
    </div>
  );
}
