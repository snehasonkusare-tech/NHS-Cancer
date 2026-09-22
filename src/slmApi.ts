// Client for the NHS SLM chat API (API Gateway -> Lambda -> Aurora + OpenSearch + SageMaker).
// Set VITE_API_URL and VITE_API_KEY in .env.local (see .env.example). Every call fails soft:
// it resolves to null so the app's built-in scripted flow keeps working if the API is down.

const API_URL = import.meta.env.VITE_API_URL as string | undefined;
const API_KEY = import.meta.env.VITE_API_KEY as string | undefined;

/** False when VITE_API_URL/VITE_API_KEY are missing, so every call short-circuits to the
 *  scripted flow. Surfaced in the UI: an unconfigured build otherwise looks like a working
 *  one that simply has nothing useful to say. */
export const apiConfigured = Boolean(API_URL && API_KEY);

export interface SlmReply {
  answer: string;
  /** Set when the backend's emergency/crisis screen fired: 'crisis', 'chest', 'abdomen', ... */
  safety: string | null;
  /** 'out' when the question isn't about the patient's health, so it never reached the model. */
  scope: string | null;
  /** True when the guided question set is exhausted and the intake should move to the summary. */
  done: boolean;
}

async function post(body: Record<string, unknown>, timeoutMs: number): Promise<SlmReply | null> {
  if (!API_URL || !API_KEY) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { answer: String(data.answer ?? ''), safety: data.safety ?? null, scope: data.scope ?? null, done: !!data.done };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fast emergency/crisis screen (no database or model). Resolves to a reply only if it fired. */
export async function screenMessage(question: string): Promise<SlmReply | null> {
  const r = await post({ question, safety_only: true }, 4000);
  return r && r.safety ? r : null;
}

/** Full answer from the fine-tuned model, personalised by NHS number. */
export async function askSlm(
  nhsNumber: string,
  question: string,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
): Promise<SlmReply | null> {
  const r = await post({ nhs_number: nhsNumber, question, mode: 'intake', history }, 28000);
  return r && r.answer ? r : null;
}

export type LoginResult =
  | { status: 'found'; fullName: string; gpPractice: string; postcode?: string }
  | { status: 'notFound' }
  | { status: 'error' };

export type RegisterResult =
  | { status: 'created'; fullName: string; gpPractice: string }
  /** The NHS number already belongs to an account, so they should log in instead. */
  | { status: 'duplicate' }
  | { status: 'invalid'; message: string }
  | { status: 'error' };

/** Creates an account in the patient database so the person can log back in later. */
export async function registerPatient(u: {
  fullName: string; nhsNumber: string; dob: string; postcode: string; gpPractice: string; consent: boolean;
}): Promise<RegisterResult> {
  if (!API_URL || !API_KEY) return { status: 'error' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({
        mode: 'register',
        full_name: u.fullName, nhs_number: u.nhsNumber, dob: u.dob,
        postcode: u.postcode, gp_practice: u.gpPractice, consent: u.consent,
      }),
      signal: ctrl.signal,
    });
    if (res.status === 409) return { status: 'duplicate' };
    if (res.status === 400) {
      const d = await res.json().catch(() => ({}));
      return { status: 'invalid', message: String(d.error ?? 'Please check the details you entered.') };
    }
    if (!res.ok) return { status: 'error' };
    const data = await res.json();
    return { status: 'created', fullName: String(data.full_name), gpPractice: String(data.gp_practice) };
  } catch {
    return { status: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/** Checks NHS number + date of birth (yyyy-mm-dd) against the patient database. */
export async function lookupPatient(nhsNumber: string, dob: string): Promise<LoginResult> {
  if (!API_URL || !API_KEY) return { status: 'error' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ mode: 'login', nhs_number: nhsNumber, dob }),
      signal: ctrl.signal,
    });
    if (res.status === 404) return { status: 'notFound' };
    if (!res.ok) return { status: 'error' };
    const data = await res.json();
    return {
      status: 'found',
      fullName: String(data.full_name),
      gpPractice: String(data.gp_practice),
      ...(data.postcode ? { postcode: String(data.postcode) } : {}),
    };
  } catch {
    return { status: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

export interface PrepItem {
  test: string;
  category: string;
  cancer: string; // the NG12 'possible cancer' this suggestion relates to, e.g. 'Ovarian'
  why: string;
  before: string;
  day_of: string;
  bring: string;
  after: string;
}

export interface PreparationResult {
  /** 'refer': symptoms match an NG12 criterion. 'safetynet': nothing matches, so no referral is suggested yet. */
  outcome: 'refer' | 'safetynet';
  items: PrepItem[];
}

/** What the GP is likely to suggest for these symptoms (with preparation detail from the NHS workbook), or safety netting. */
export async function getPreparation(nhsNumber: string, text: string): Promise<PreparationResult | null> {
  if (!API_URL || !API_KEY) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ mode: 'prepare', nhs_number: nhsNumber, text }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.items)) return null;
    return { outcome: data.outcome === 'safetynet' ? 'safetynet' : 'refer', items: data.items as PrepItem[] };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
