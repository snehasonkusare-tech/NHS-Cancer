// Voice input (speech to text) and read-aloud (text to speech) using the browser's built-in Web Speech API.
// No audio is sent to our servers; the browser's speech service handles it. Support varies by browser
// (Chrome, Edge and Safari support recognition; Firefox does not), so callers must check `voiceInputSupported`.

/* eslint-disable @typescript-eslint/no-explicit-any */
const SpeechRecognitionCtor: any =
  typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : undefined;

export const voiceInputSupported = !!SpeechRecognitionCtor;
export const readAloudSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

// English only for now: the chatbot's model is fine-tuned in English. To add a language later, add it here
// (BCP-47 code) and check the model can answer in it first.
export const VOICE_LANGUAGES: { code: string; label: string }[] = [
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'en-US', label: 'English (US)' },
];

export type VoiceError = 'blocked' | 'no-speech' | 'network' | 'unsupported' | 'other';

export interface VoiceSession {
  stop: () => void;
}

/**
 * Starts listening. `onText` receives the running transcript (interim results included) so the text box fills
 * as the person speaks; `onFinal` fires once with the finished transcript; `onEnd` always fires last.
 */
export function startListening(opts: {
  lang: string;
  onText: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (e: VoiceError) => void;
  onEnd: () => void;
}): VoiceSession | null {
  if (!SpeechRecognitionCtor) { opts.onError('unsupported'); opts.onEnd(); return null; }
  const rec = new SpeechRecognitionCtor();
  rec.lang = opts.lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let transcript = '';
  let failed = false;
  rec.onresult = (ev: any) => {
    let text = '';
    for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
    transcript = text.trim();
    opts.onText(transcript);
  };
  rec.onerror = (ev: any) => {
    failed = true;
    const code = String(ev?.error ?? '');
    opts.onError(code === 'not-allowed' || code === 'service-not-allowed' ? 'blocked'
      : code === 'no-speech' ? 'no-speech' : code === 'network' ? 'network' : 'other');
  };
  rec.onend = () => {
    if (!failed && transcript) opts.onFinal(transcript);
    opts.onEnd();
  };
  try { rec.start(); } catch { opts.onError('other'); opts.onEnd(); return null; }
  return { stop: () => { try { rec.stop(); } catch { /* already stopped */ } } };
}

export function speak(text: string, lang: string) {
  if (!readAloudSupported) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
  } catch { /* speech is a convenience; never break the chat */ }
}

export function stopSpeaking() {
  if (readAloudSupported) { try { window.speechSynthesis.cancel(); } catch { /* ignore */ } }
}
