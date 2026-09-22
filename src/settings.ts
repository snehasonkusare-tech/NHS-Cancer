import { VOICE_LANGUAGES } from './voice';

// App settings, saved on this device only (localStorage). Every read/write is wrapped because storage can be
// unavailable (private windows, blocked site data) and settings must never stop the app working.

export type TextSize = 'small' | 'default' | 'large' | 'xlarge';

export interface Settings {
  voiceLang: string;        // speech-recognition and read-aloud language
  autoSendVoice: boolean;   // send the message as soon as speaking stops
  readAloud: boolean;       // read the chatbot's replies aloud
  textSize: TextSize;
  highContrast: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  voiceLang: 'en-GB',
  autoSendVoice: false,
  readAloud: false,
  textSize: 'default',
  highContrast: false,
};

export const TEXT_ZOOM: Record<TextSize, number> = { small: 0.92, default: 1, large: 1.12, xlarge: 1.25 };

const KEY = 'oncoway.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const saved = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    // A language chosen in an earlier version may no longer be offered: fall back to the default.
    if (!VOICE_LANGUAGES.some(l => l.code === saved.voiceLang)) saved.voiceLang = DEFAULT_SETTINGS.voiceLang;
    return saved;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}
