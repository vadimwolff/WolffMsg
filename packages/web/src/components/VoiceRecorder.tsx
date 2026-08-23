/**
 * Voice message recording.
 *
 * Uses MediaRecorder for capture and an AnalyserNode for the live waveform.
 * The microphone track is stopped explicitly on every exit path — cancel, send
 * and unmount alike — so the browser's recording indicator never lingers after
 * the user is done.
 */
import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { waveformFromSamples } from '@wolffmsg/shared';
import { IconButton, Spinner } from './primitives.tsx';
import { AlertIcon, CloseIcon, MicIcon, SendIcon } from './icons.tsx';
import { formatDuration } from '../lib/format.ts';

const MAX_DURATION_MS = 5 * 60 * 1000;

interface Props {
  onCancel: () => void;
  onSend: (blob: Blob, durationMs: number, waveform: number[]) => void;
}

export function VoiceRecorder({ onCancel, onSend }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(true);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedAt = useRef(0);
  const samplesRef = useRef<number[]>([]);

  /** Every teardown path funnels here, so nothing is left running. */
  function releaseEverything() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    recorderRef.current?.state === 'recording' && recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
  }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;

        const mimeType = pickMimeType();
        const recorder = new MediaRecorder(
          stream,
          mimeType ? { mimeType } : undefined,
        );
        recorderRef.current = recorder;
        chunksRef.current = [];
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.start(250);
        startedAt.current = Date.now();
        setPreparing(false);

        // Live level meter.
        const context = new AudioContext();
        audioContextRef.current = context;
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);

        const buffer = new Float32Array(analyser.fftSize);
        const tick = () => {
          analyser.getFloatTimeDomainData(buffer);
          let peak = 0;
          for (const sample of buffer) {
            const value = Math.abs(sample);
            if (value > peak) peak = value;
          }
          samplesRef.current.push(peak);
          setLevels((prev) => [...prev.slice(-59), Math.min(1, peak * 2.2)]);

          const duration = Date.now() - startedAt.current;
          setElapsed(duration);
          if (duration >= MAX_DURATION_MS) {
            finish();
            return;
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (err) {
        if (cancelled) return;
        setPreparing(false);
        setError(
          (err as Error).name === 'NotAllowedError'
            ? 'Microphone access was denied.'
            : 'Could not start recording on this device.',
        );
      }
    })();

    return () => {
      cancelled = true;
      releaseEverything();
    };
    // Mount-only: the recorder must not restart when state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function finish() {
    const recorder = recorderRef.current;
    if (!recorder) return;

    const duration = Date.now() - startedAt.current;
    // Compress the collected peaks into the fixed-width envelope that travels
    // with the message.
    const waveform = waveformFromSamples(
      Float32Array.from(samplesRef.current.map((v) => Math.min(1, v * 2.2))),
      48,
    );

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || 'audio/webm',
      });
      releaseEverything();
      if (blob.size > 0 && duration > 400) {
        onSend(blob, duration, waveform);
      } else {
        onCancel();
      }
    };

    if (recorder.state === 'recording') recorder.stop();
    else recorder.onstop?.(new Event('stop'));
  }

  if (error) {
    return (
      <div className="composer composer-readonly" role="alert">
        <AlertIcon size={16} />
        {error}
        <button type="button" className="composer-inline-action" onClick={onCancel}>
          Close
        </button>
      </div>
    );
  }

  return (
    <motion.div
      className="composer recorder"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <IconButton
        label="Discard recording"
        variant="danger"
        onClick={() => {
          releaseEverything();
          onCancel();
        }}
      >
        <CloseIcon />
      </IconButton>

      <div className="recorder-body">
        <span className="recorder-dot" aria-hidden="true" />
        <span className="recorder-time">{formatDuration(elapsed)}</span>
        <div className="recorder-wave" aria-hidden="true">
          {preparing ? (
            <Spinner size={16} />
          ) : (
            levels.map((level, index) => (
              <span
                key={index}
                className="recorder-bar"
                style={{ height: `${Math.max(8, level * 100)}%` }}
              />
            ))
          )}
        </div>
        <span className="sr-only" aria-live="polite">
          Recording, {Math.round(elapsed / 1000)} seconds
        </span>
      </div>

      <IconButton
        label="Send voice message"
        variant="primary"
        size="lg"
        disabled={preparing || elapsed < 500}
        onClick={finish}
      >
        <SendIcon />
      </IconButton>

      <span className="sr-only">
        <MicIcon />
      </span>
    </motion.div>
  );
}

/** Pick a container the browser will actually record. */
function pickMimeType(): string | null {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported?.(candidate)) return candidate;
  }
  return null;
}
