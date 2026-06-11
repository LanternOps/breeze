import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';

import {
  initialVoiceState,
  reduceVoice,
  type VoicePermission,
  type VoiceState,
} from './voiceState';

// expo-speech-recognition is loaded lazily and tolerantly: if the native
// module isn't linked into the current binary (e.g. the developer hasn't
// rebuilt the iOS app since the package was added), we still want the
// surrounding app to boot. The hook then exposes `available: false` and
// the Composer renders the mic in a disabled state with a helpful tooltip.
type SpeechModule = {
  start: (options: {
    lang?: string;
    interimResults?: boolean;
    continuous?: boolean;
    requiresOnDeviceRecognition?: boolean;
  }) => void;
  stop: () => void;
  abort: () => void;
  getPermissionsAsync: () => Promise<{ granted: boolean }>;
  requestPermissionsAsync: () => Promise<{ granted: boolean }>;
  addListener: (event: string, fn: (e: any) => void) => { remove: () => void };
};

let speech: SpeechModule | null = null;
let speechLoadAttempted = false;

function loadSpeech(): SpeechModule | null {
  if (speechLoadAttempted) return speech;
  speechLoadAttempted = true;
  try {
    // require() rather than top-level import: a missing native binding
    // throws at module load time on RN, and we want to swallow that.
    const mod = require('expo-speech-recognition');
    speech = mod?.ExpoSpeechRecognitionModule ?? null;
  } catch {
    speech = null;
  }
  return speech;
}

export interface VoiceInputOptions {
  offline: boolean;
  onTranscript: (text: string) => void;
}

export interface VoiceInputApi {
  state: VoiceState;
  available: boolean;
  toggle: () => void;
  openSettings: () => void;
}

export function useVoiceInput({ offline, onTranscript }: VoiceInputOptions): VoiceInputApi {
  const [state, setState] = useState<VoiceState>(initialVoiceState);
  const [permission, setPermission] = useState<VoicePermission>('unknown');
  const transcriptRef = useRef<string>('');
  const moduleRef = useRef<SpeechModule | null>(null);

  // Resolve the native module once. If it's missing we render disabled.
  if (moduleRef.current === null) {
    moduleRef.current = loadSpeech();
  }
  const available = moduleRef.current !== null;

  // Subscribe to native events for the lifetime of the hook.
  useEffect(() => {
    const mod = moduleRef.current;
    if (!mod) return;

    const subs = [
      mod.addListener('start', () => {
        setState((s) => reduceVoice(s, { type: 'started' }));
      }),
      mod.addListener('result', (e: { isFinal?: boolean; results?: { transcript?: string }[] }) => {
        const text = e?.results?.[0]?.transcript ?? '';
        if (typeof text === 'string' && text.length > 0) {
          transcriptRef.current = text;
        }
        if (e?.isFinal) {
          if (transcriptRef.current) onTranscript(transcriptRef.current);
          transcriptRef.current = '';
          setState((s) => reduceVoice(s, { type: 'final-result' }));
        }
      }),
      mod.addListener('end', () => {
        // If the native side ended without a final result, flush whatever we have.
        setState((s) => {
          if (s.kind === 'listening' || s.kind === 'transcribing') {
            if (transcriptRef.current) onTranscript(transcriptRef.current);
            transcriptRef.current = '';
            return reduceVoice(s, { type: 'final-result' });
          }
          return s;
        });
      }),
      mod.addListener('error', (e: { error?: string }) => {
        const code = e?.error ?? '';
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          setPermission('denied');
          setState((s) => reduceVoice(s, { type: 'failed', reason: 'permission-denied' }));
        } else {
          setState((s) => reduceVoice(s, { type: 'failed', reason: 'recognition-failed' }));
        }
      }),
    ];

    return () => {
      for (const sub of subs) sub.remove();
    };
  }, [onTranscript]);

  // Probe permissions once on mount (best-effort — failures don't block UI).
  useEffect(() => {
    const mod = moduleRef.current;
    if (!mod) return;
    let cancelled = false;
    mod
      .getPermissionsAsync()
      .then((p) => {
        if (cancelled) return;
        setPermission(p?.granted ? 'granted' : 'unknown');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-clear errors after a few seconds so the UI doesn't get stuck.
  useEffect(() => {
    if (state.kind !== 'error') return;
    const t = setTimeout(() => {
      setState((s) => (s.kind === 'error' ? reduceVoice(s, { type: 'reset' }) : s));
    }, 3500);
    return () => clearTimeout(t);
  }, [state]);

  const toggle = useCallback(() => {
    const mod = moduleRef.current;
    if (!mod) {
      setState((s) => reduceVoice(s, { type: 'failed', reason: 'unavailable' }));
      return;
    }

    setState((prev) => {
      const next = reduceVoice(prev, { type: 'press', offline, permission });

      // Side effects driven off the resulting state.
      if (next.kind === 'transcribing' && prev.kind === 'listening') {
        try {
          mod.stop();
        } catch {
          // swallow; the 'end' listener will reconcile.
        }
      }

      if (next.kind === 'requesting' && prev.kind !== 'requesting') {
        // Either we have permission and just need to start, or we need to
        // request it first. Either way, settle async then call start().
        const startSession = () => {
          try {
            mod.start({
              lang: 'en-US',
              interimResults: true,
              continuous: false,
              requiresOnDeviceRecognition: true,
            });
          } catch {
            setState((s) => reduceVoice(s, { type: 'failed', reason: 'recognition-failed' }));
          }
        };

        if (permission === 'granted') {
          startSession();
        } else {
          mod
            .requestPermissionsAsync()
            .then((p) => {
              const granted = !!p?.granted;
              setPermission(granted ? 'granted' : 'denied');
              setState((s) => reduceVoice(s, { type: 'permission-resolved', granted }));
              if (granted) startSession();
            })
            .catch(() => {
              setState((s) => reduceVoice(s, { type: 'failed', reason: 'permission-denied' }));
            });
        }
      }

      return next;
    });
  }, [offline, permission]);

  const openSettings = useCallback(() => {
    Linking.openSettings().catch(() => undefined);
  }, []);

  return { state, available, toggle, openSettings };
}
