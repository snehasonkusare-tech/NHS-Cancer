import { useState, useEffect, useRef, useCallback } from 'react';
import logoImage from './imports/logo.png';
import logoMark from './imports/logo-mark.png'
import { screenMessage, askSlm, lookupPatient, registerPatient, getPreparation, apiConfigured, type PrepItem } from './slmApi';
import { startListening, speak, stopSpeaking, voiceInputSupported, readAloudSupported, VOICE_LANGUAGES, type VoiceSession, type VoiceError } from './voice';
import { loadSettings, saveSettings, DEFAULT_SETTINGS, TEXT_ZOOM, type Settings, type TextSize } from './settings';

// Embedded directly as a data URI (not a separate file import) — this file
// kept failing to resolve because logo-mark.png was never actually uploaded
// to the project. Embedding it removes that failure mode entirely: there is
// no second file for this specific mark to go missing.

// ─── Types ────────────────────────────────────────────────────────────────────

type Screen =
  | 'splash' | 'welcome' | 'login' | 'register' | 'home' | 'profile'
  | 'chat' | 'reasoning' | 'submitting' | 'review'
  | 'nextSteps' | 'safetyNet' | 'notSubmitted'
  | 'emergency' | 'chatHistory' | 'chatTranscript' | 'settings';

// How many model-driven follow-up questions to ask before moving on to the summary.
const MAX_MODEL_QUESTIONS = 3;

// Offered alongside the symptom categories when the guidance service can't be reached, so the
// patient is never forced to pick a category that has nothing to do with their symptoms.
const NONE_OF_THESE = 'None of these describe it';

// Offered alongside every set of fixed answers. The options can never cover how someone
// actually experiences a symptom, and forcing a near-enough choice puts words in their mouth
// that then travel into the GP summary.
const SOMETHING_ELSE = 'Something else — let me explain';

const withSomethingElse = (options: string[]) => [...options, SOMETHING_ELSE];

type ChatPhase = 'initial' | 'clarify' | 'q0' | 'q1' | 'q2' | 'done' | 'noMatch';

interface User {
  fullName: string;
  nhsNumber: string;
  dob: string;
  postcode: string;
  gpPractice: string;
  consent: boolean;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'bot';
  text: string;
  quickReplies?: string[];
  time?: string;
}

interface FollowUpQ {
  question: string;
  options: string[];
}

interface SymptomCategory {
  id: string;
  label: string;
  pathway: string;
  referralType: string;
  reassuranceStat: string;
  ng12Criterion: string;
  reasoning: string;
  possibilities: string[];
  followUpQuestions: FollowUpQ[];
}

interface SessionData {
  category: SymptomCategory | null;
  userInput: string;
  answers: string[];
  matchedNG12: boolean;
  messages: ChatMessage[];
  submittedToGP: boolean;
}

interface HistoryEntry {
  id: string;
  timestamp: Date;
  status: 'submitted' | 'safety-netting' | 'emergency' | 'not-submitted';
  pathway?: string;
  messages: ChatMessage[];
}

// ─── Workbook Data (from nhs_slm_full_journey_workbook__13_.xlsx) ─────────────

const TOP_TIPS = [
  'Write down your symptoms and when they started — this helps your doctor enormously.',
  'Bring someone you trust. A second pair of ears can be really helpful.',
  'Note all medications you take, including vitamins and supplements.',
  "It's okay to ask your doctor to repeat or explain anything — take your time.",
  "Ask 'What happens next?' — knowing the process helps reduce anxiety.",
  'Bring a list of any allergies or previous medical conditions.',
  'Arrive 10–15 minutes early to complete any paperwork without rushing.',
];

const QUESTIONS_TO_ASK = [
  'What tests will I be having, and when will I get the results?',
  'How will I be told the results — by phone, letter, or online?',
  'Who should I contact if my symptoms worsen before the next appointment?',
  'What does the 2-week wait referral process actually involve?',
  'What possible diagnoses are you considering at this stage?',
  'Is there anything I should or shouldn\'t do in the meantime?',
  'Can I bring someone with me to further appointments?',
];

const PREPARATION_SUPPORT = [
  { label: 'Macmillan Cancer Support', detail: '0808 808 00 00 — free helpline, 7 days a week' },
  { label: 'NHS 111', detail: 'Call 111 for urgent non-emergency medical guidance' },
  { label: 'Samaritans', detail: '116 123 — free, 24/7, if you\'re feeling overwhelmed' },
  { label: 'Mind', detail: '0300 123 3393 — mental health support during uncertain times' },
];

const REFERRAL_EXPLANATIONS: Record<string, string> = {
  '2WW':
    "A 2-Week Wait (2WW) referral means your GP has identified symptoms that — while probably not cancer — need specialist review within two weeks. It's a precautionary measure designed to rule things out quickly.",
  safetyNet:
    'Safety-netting means your GP will keep a watchful eye on your symptoms over the next 14 days. You\'ll be asked to return if anything persists, worsens, or changes.',
};

// Only these three are verified real CRUK leaflet links (per Symptom Resource
// Links tab — Verified = Yes). Every other category is deliberately absent:
// don't add one back without fetching and confirming the real URL first.
// This is the ONE real, repeatedly-verified short link CRUK prints on their
// leaflets (bowel, lung, and general) — "cruk.org/spotcancerearly". There is
// no separate per-cancer-type address (an earlier version of this fabricated
// /spot-lung-cancer-early, /spot-bowel-cancer-early, etc. — those don't exist
// and 404). All three categories point to the same real page; only the label
// and blurb differ.
// ─── Symptom Categories ────────────────────────────────────────────────────────

const SYMPTOM_CATEGORIES: SymptomCategory[] = [
  {
    id: 'haematuria',
    label: 'Blood in urine (haematuria)',
    pathway: 'Urology — suspected bladder / kidney cancer',
    referralType: '2WW',
    reassuranceStat: 'Over 9 in 10 people referred on this pathway are not diagnosed with cancer.',
    ng12Criterion: 'Unexplained haematuria in adults aged 45+ (NICE NG12, recommendation 1.3)',
    reasoning:
      'Blood in urine — particularly when painless and unexplained — is a key NICE NG12 referral criterion. In adults aged 45 or over, this symptom warrants urgent specialist review to exclude bladder or kidney cancer. Painless haematuria carries a higher risk association than painful haematuria, which is more commonly linked to benign causes such as urinary tract infection or kidney stones.',
    possibilities: [
      'Urinary tract infection or kidney stones (most common cause)',
      'Benign prostate enlargement or bladder polyp',
      'Bladder or kidney tumour — warrants urgent review to exclude',
    ],
    followUpQuestions: [
      { question: 'How long have you noticed blood in your urine?', options: ['Less than a week', '1–4 weeks', 'More than a month'] },
      { question: 'How old are you?', options: ['Under 45', '45–60', 'Over 60'] },
      { question: 'Is there any pain when you urinate?', options: ["Yes — it's painful", 'No — it\'s painless', 'Occasional discomfort'] },
    ],
  },
  {
    id: 'haemoptysis',
    label: 'Coughing up blood (haemoptysis)',
    pathway: 'Respiratory — suspected lung cancer',
    referralType: '2WW',
    reassuranceStat: 'Over 9 in 10 people referred on this pathway are not diagnosed with cancer.',
    ng12Criterion: 'Unexplained haemoptysis in adults aged 40+ (NICE NG12, recommendation 1.11)',
    reasoning:
      "Coughing up blood — even in small amounts — is a NICE NG12 criterion for urgent referral in adults aged 40 and over, particularly in current or ex-smokers. Most cases are caused by benign conditions such as chest infections or bronchitis, but the NG12 guidance requires specialist assessment to exclude lung cancer.",
    possibilities: [
      'Chest infection, bronchitis, or bronchiectasis (most common)',
      'Pulmonary embolism in higher-risk individuals',
      'Lung cancer — warrants urgent referral to exclude, especially in smokers',
    ],
    followUpQuestions: [
      { question: 'How much blood have you noticed?', options: ['Streaks in phlegm', 'About a teaspoon', 'More than that'] },
      { question: 'Do you smoke or have you smoked?', options: ['Yes — I currently smoke', "I'm an ex-smoker", "I've never smoked"] },
      { question: 'Any persistent cough or chest pain alongside this?', options: ['Persistent cough', 'Chest pain too', 'Neither'] },
    ],
  },
  {
    id: 'rectalBleeding',
    label: 'Rectal bleeding',
    pathway: 'Colorectal — suspected bowel cancer',
    referralType: '2WW',
    reassuranceStat: 'Over 9 in 10 people referred on this pathway are not diagnosed with cancer.',
    ng12Criterion: 'Rectal bleeding with change in bowel habit towards looser stools in adults aged 40+ (NICE NG12, recommendation 1.6)',
    reasoning:
      'Rectal bleeding combined with a change in bowel habit — particularly looser stools or increased frequency — is an NICE NG12 criterion for urgent 2-week wait referral. Rectal bleeding alone is more commonly caused by haemorrhoids or anal fissures, but when combined with bowel changes in adults over 40, specialist review is indicated to exclude colorectal cancer.',
    possibilities: [
      'Haemorrhoids or anal fissure (most common cause of rectal bleeding)',
      'Inflammatory bowel disease (Crohn\'s or ulcerative colitis)',
      'Colorectal polyp or bowel cancer — urgent exclusion when combined with bowel changes',
    ],
    followUpQuestions: [
      { question: 'What colour is the blood?', options: ['Bright red', 'Dark red or maroon', 'Mixed with stool'] },
      { question: 'Have you noticed a change in your bowel habit?', options: ['Looser stools than usual', 'More constipated', 'No change'] },
      { question: 'Any abdominal pain alongside the bleeding?', options: ['Yes — regularly', 'Sometimes', 'No pain'] },
    ],
  },
  {
    id: 'weightLoss',
    label: 'Unexplained weight loss',
    pathway: 'General / Oncology — unexplained weight loss investigation',
    referralType: '2WW',
    reassuranceStat: 'Most people with unexplained weight loss have a non-cancer cause — but specialist review is recommended.',
    ng12Criterion: 'Unexplained weight loss in adults aged 40+ with additional symptoms (NICE NG12, multiple recommendations)',
    reasoning:
      'Significant unexplained weight loss — more than 5% of body weight in six months without a known cause — is a flag across multiple NICE NG12 cancer pathways. When accompanied by fatigue, loss of appetite, or other symptoms, it warrants investigation to exclude an underlying malignancy, including gastrointestinal, lung, or lymphoma-type cancers.',
    possibilities: [
      'Thyroid disorder, diabetes, or other metabolic causes (common)',
      'Depression, anxiety, or reduced appetite from psychological causes',
      'Gastrointestinal, lung, or lymphoma — requires investigation to exclude',
    ],
    followUpQuestions: [
      { question: 'How much weight have you lost, and over how long?', options: ['A small amount over months', '5–10% of my body weight', 'Over 10% of my body weight'] },
      { question: 'Has your appetite changed?', options: ["Yes — I've lost my appetite", 'I eat less but still have appetite', 'No change in appetite'] },
      { question: 'Any other symptoms alongside this?', options: ['Fatigue or tiredness', 'Nausea or sickness', 'Nothing specific'] },
    ],
  },
  {
    id: 'breast',
    label: 'Breast lump or change',
    pathway: 'Breast — suspected breast cancer',
    referralType: '2WW',
    reassuranceStat: 'Over 9 in 10 people referred to a breast clinic are not diagnosed with cancer.',
    ng12Criterion: 'Unexplained breast lump in women aged 30+ (NICE NG12, recommendation 1.16)',
    reasoning:
      'A new, unexplained breast lump — particularly in women aged 30 and over — meets the NICE NG12 criteria for an urgent 2-week wait referral. The majority of breast lumps are benign (cysts, fibroadenomas), but timely specialist assessment is important. Skin changes, nipple discharge, or tethering alongside a lump increase clinical concern.',
    possibilities: [
      'Benign cyst or fibroadenoma (most common — over 80% of referred lumps are benign)',
      'Hormonal or fibrocystic changes, particularly in premenopausal women',
      'Breast cancer — warrants urgent specialist review to confirm or exclude',
    ],
    followUpQuestions: [
      { question: 'How long have you had this lump or change?', options: ['Less than 2 weeks', '2–6 weeks', 'More than 6 weeks'] },
      { question: 'Any skin changes around it?', options: ['Dimpling of the skin', 'Redness or warmth', 'No skin changes'] },
      { question: 'Any discharge from your nipple?', options: ["Yes — there's discharge", 'No discharge', "I'm not sure"] },
    ],
  },
  {
    id: 'skin',
    label: 'Changing mole or skin lesion',
    pathway: 'Dermatology — suspected melanoma',
    referralType: '2WW',
    reassuranceStat: 'Over 9 in 10 people referred for a skin lesion are not diagnosed with melanoma.',
    ng12Criterion: 'Lesion suspicious of melanoma (weighted 7-point checklist score ≥3) in adults (NICE NG12, recommendation 1.9)',
    reasoning:
      'A mole or skin lesion that has changed in size, shape, or colour — or that bleeds or itches unexpectedly — is assessed using the 7-point weighted checklist. NICE NG12 recommends urgent referral when a lesion scores three or more. Early detection of melanoma significantly improves outcomes, making timely assessment essential.',
    possibilities: [
      'Benign seborrhoeic keratosis (age-related skin spots — very common)',
      'Dysplastic naevus (abnormal but non-cancerous mole requiring monitoring)',
      'Melanoma — requires urgent dermatologist review; early detection is key',
    ],
    followUpQuestions: [
      { question: 'How long has the mole or lesion been changing?', options: ['Less than 4 weeks', '1–3 months', 'More than 3 months'] },
      { question: 'How has it changed?', options: ["It's grown in size", 'The colour or shape changed', 'Both size and colour/shape'] },
      { question: 'Is it itching or bleeding?', options: ['Yes — it itches', 'Yes — it bleeds', 'Neither'] },
    ],
  },
  {
    id: 'dysphagia',
    label: 'Difficulty swallowing (dysphagia)',
    pathway: 'Upper GI — suspected oesophageal / gastric cancer',
    referralType: '2WW',
    reassuranceStat: 'Over 9 in 10 people referred on this pathway are not diagnosed with cancer.',
    ng12Criterion: 'Dysphagia in adults of any age (NICE NG12, recommendation 1.4)',
    reasoning:
      "Difficulty swallowing — especially a feeling of food sticking, or progressive difficulty from solids to liquids — is a key NICE NG12 criterion for urgent referral regardless of age. Most causes are benign (reflux disease, oesophageal stricture), but oesophageal and gastric cancers must be promptly excluded with specialist assessment.",
    possibilities: [
      'Gastro-oesophageal reflux disease (GORD) or oesophagitis (most common)',
      'Stricture or motility disorder of the oesophagus',
      'Oesophageal or gastric cancer — requires urgent specialist assessment',
    ],
    followUpQuestions: [
      { question: 'Does it affect solids, liquids, or both?', options: ['Solids only', 'Both solids and liquids', 'Getting progressively worse'] },
      { question: 'Any unintentional weight loss alongside this?', options: ["Yes — I've lost weight", "Not that I've noticed", "I'm not sure"] },
      { question: 'Any heartburn or acid reflux?', options: ['Yes — frequent heartburn', 'Occasional only', 'No, not at all'] },
    ],
  },
  {
    id: 'pmb',
    label: 'Postmenopausal bleeding',
    pathway: 'Gynaecology — suspected endometrial / cervical cancer',
    referralType: '2WW',
    reassuranceStat: 'Over 9 in 10 people referred for postmenopausal bleeding are not diagnosed with cancer.',
    ng12Criterion: 'Postmenopausal bleeding in women aged 55+ (NICE NG12, recommendation 1.7)',
    reasoning:
      'Any vaginal bleeding after the menopause is an NICE NG12 criterion for urgent 2-week wait referral. In most cases the cause is benign — atrophic vaginitis or an endometrial polyp — but endometrial cancer (the most common gynaecological cancer in the UK) must be excluded promptly.',
    possibilities: [
      'Atrophic vaginitis or vaginal atrophy (most common cause in postmenopausal women)',
      'Endometrial or cervical polyp',
      'Endometrial cancer — requires urgent gynaecological assessment',
    ],
    followUpQuestions: [
      { question: 'How long since your last period before this bleeding?', options: ['1–2 years ago', '2–5 years ago', 'More than 5 years ago'] },
      { question: 'Has this happened more than once?', options: ['Just once so far', 'A few times', "It's happening regularly"] },
      { question: 'Any pelvic pain alongside it?', options: ['Yes — pelvic pain', 'Mild discomfort only', 'No pain at all'] },
    ],
  },
  {
    id: 'abdomen',
    label: 'Abdominal mass or persistent pain',
    pathway: 'General Surgery / Upper GI — suspected abdominal cancer',
    referralType: '2WW',
    reassuranceStat: 'Most abdominal masses referred on this pathway have a non-cancer cause.',
    ng12Criterion: 'Unexplained palpable abdominal mass in adults (NICE NG12, recommendation 1.5)',
    reasoning:
      'A new or growing mass in the abdomen — or persistent pain without a clear cause — meets NICE NG12 criteria for urgent referral. Most abdominal masses are benign (fibroids, ovarian cysts, bowel gas), but in adults without an obvious explanation, specialist assessment is important to rule out pancreatic, liver, or colorectal cancer.',
    possibilities: [
      'Fibroids, ovarian cyst, or bowel-related cause (most common in younger adults)',
      'Hernia or enlarged lymph node',
      'Pancreatic, liver, or colorectal cancer — urgent imaging required to exclude',
    ],
    followUpQuestions: [
      { question: 'Where is the mass or pain located?', options: ['Upper abdomen', 'Lower abdomen', "It's more widespread"] },
      { question: 'How long have you noticed it?', options: ['Less than 2 weeks', '2–6 weeks', 'More than 6 weeks'] },
      { question: 'Any nausea or vomiting alongside it?', options: ['Yes — nausea and/or vomiting', 'Occasional nausea', 'None at all'] },
    ],
  },
];

// This now mirrors ALL 10 presentations in the workbook's Red Flag Emergency
// Routing tab (999 tier only — the 111 tier is documented in the workbook but
// deliberately not wired in here yet, since it needs a different UI response,
// not a full stop). Each row below is commented with which red-flag row it
// covers, so this list stays traceable back to the source table instead of
// drifting from it over time.
const EMERGENCY_PATTERNS = [
  // Severe, crushing chest pain, sudden onset
  'crushing chest pain', 'chest pain', 'tight chest', 'heart attack',
  // Coughing up a large amount of blood
  'large amount of blood', 'lots of blood', 'coughing up blood and',
  'coughing up a large', 'choking on blood', 'vomiting blood',
  // Sudden severe headache, worst ever, with vision changes or confusion
  'worst headache', 'thunderclap headache', 'sudden severe headache', 'worst ever headache',
  // Severe difficulty breathing, unable to speak in full sentences
  "can't breathe", 'cannot breathe', 'difficulty breathing', "can't speak in full sentences",
  // Uncontrolled or very heavy bleeding from any site
  'severe bleeding', 'blood everywhere', 'won\'t stop bleeding', 'bleeding heavily',
  // Signs of sepsis: fever with confusion, mottled skin, extreme lethargy
  'sepsis', 'mottled skin', 'fever and confusion', 'fever with confusion',
  // Sudden weakness or numbness on one side of the body, or slurred speech
  'stroke', 'weakness on one side', 'numbness on one side', 'slurred speech', 'face drooping',
  // Signs of anaphylaxis: swelling of face/throat, difficulty breathing after a trigger
  'anaphylaxis', 'throat swelling', 'face swelling', 'swelling of my throat',
  // Severe abdominal pain with rigid abdomen, unable to move due to pain
  'rigid abdomen', 'abdomen is rigid', "can't move because of the pain",
  // Fitting/seizure that does not stop within 5 minutes, or first-ever seizure
  'seizure', "seizure that won't stop", 'fit that won\'t stop', 'first seizure',
  // General collapse / consciousness — not tied to one specific row, but
  // clearly 999 under any of them
  'collapsed', 'losing consciousness', 'passed out',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Used when the patient described symptoms in their own words and none of the specific NG12
// categories above matched. It lets the conversation continue through the same summary,
// "submit to your GP" and appointment-preparation screens as every other journey.
const GENERAL_CATEGORY_ID = 'general';
function buildGeneralCategory(userInput: string): SymptomCategory {
  return {
    id: GENERAL_CATEGORY_ID,
    label: 'Your symptoms — GP review',
    pathway: 'GP assessment',
    referralType: 'Routine GP review',
    reassuranceStat: "Getting symptoms checked early is the best way to put your mind at rest, or to catch anything sooner rather than later.",
    ng12Criterion: 'No specific NG12 referral criterion identified from this conversation yet — your GP will assess this properly.',
    reasoning: `You described: \u201c${userInput}\u201d\n\nFrom what you've told us, your symptoms don't match a specific NG12 referral criterion yet. That doesn't mean they aren't worth looking at. Your GP can examine you, ask more questions and decide whether any tests or a referral are needed.`,
    possibilities: [
      'It may turn out to be something common and easily treated.',
      'Your GP may want to arrange a few simple tests to find out more.',
      'Occasionally, a specialist may need to take a closer look.',
    ],
    followUpQuestions: [],
  };
}

// Follow-up answers often deny a symptom ("no blood", "I haven't lost weight"). Drop those denials before
// looking for category words, so a denial can't start the wrong flow. The patient's FIRST message is never
// filtered, so a real symptom statement can't be weakened by this.
function stripNegated(text: string): string {
  return text.replace(/\b(?:no|not|never|without|\w+n['\u2019]t)\s+(?:\w+\s+){0,2}?(?:weight loss|lost (?:any |much )?weight|losing weight|blood|bleeding|lump|mole|cough\w*|swallow\w*)/gi, ' ');
}

function matchCategory(input: string): SymptomCategory | null {
  const matchers: Array<{ pattern: RegExp; id: string }> = [
    { pattern: /blood.{0,20}(urine|pee|wee)|urine.{0,10}blood|pee.{0,10}blood|pink.{0,10}urine|haematuria/i, id: 'haematuria' },
    { pattern: /cough.{0,10}blood|blood.{0,10}cough|haemoptysis|spitting.{0,10}blood|phlegm.{0,10}blood/i, id: 'haemoptysis' },
    { pattern: /blood.{0,20}(stool|poo|bottom|passage|toilet)|rectal.{0,10}bleed|black.{0,5}stool/i, id: 'rectalBleeding' },
    { pattern: /weight.{0,10}loss|losing.{0,10}weight|lost.{0,10}weight/i, id: 'weightLoss' },
    { pattern: /breast.{0,10}lump|lump.{0,10}breast|nipple|breast.{0,10}change/i, id: 'breast' },
    { pattern: /mole|skin.{0,10}(change|lesion)|melanoma|dark.{0,10}patch/i, id: 'skin' },
    { pattern: /swallow|dysphagia|food.{0,10}stick/i, id: 'dysphagia' },
    { pattern: /bleed.{0,20}menopause|postmenopaus|vaginal.{0,10}bleed/i, id: 'pmb' },
    { pattern: /abdominal.{0,10}(lump|pain|mass)|lump.{0,10}(stomach|belly|tummy)|tummy.{0,10}lump/i, id: 'abdomen' },
  ];
  for (const { pattern, id } of matchers) {
    if (pattern.test(input)) {
      return SYMPTOM_CATEGORIES.find(c => c.id === id) || null;
    }
  }
  return null;
}

function isEmergency(input: string): boolean {
  const lower = input.toLowerCase();
  return EMERGENCY_PATTERNS.some(p => lower.includes(p));
}

function genId() { return Math.random().toString(36).slice(2, 9); }
function firstName(name: string) { return name.trim().split(/\s+/)[0]; }
// NHS numbers are 10 digits (shown grouped, e.g. "485 777 3456"). Strip anything
// that isn't a digit or a space, and hard-cap the length — this is what stops a
// stray paste (of anything, including this very file) from ending up stored as
// the "NHS number" and blowing out the Review screen layout.
function sanitizeNhs(raw: string) { return raw.replace(/[^0-9 ]/g, '').slice(0, 12); }
function formatTime(d: Date) {
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    + ' · ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function nowTime() {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true });
}

// ─── UI Primitives ────────────────────────────────────────────────────────────

function BackButton({ onBack, light = false }: { onBack: () => void; light?: boolean }) {
  return (
    <button onClick={onBack} className={`p-2 rounded-full transition-colors ${light ? 'hover:bg-white/10 text-white' : 'hover:bg-black/5 text-[#371A82]'}`} aria-label="Go back">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 12H5M12 5l-7 7 7 7"/>
      </svg>
    </button>
  );
}

function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  return (
    <div
      className="rounded-full bg-[#8058DF] flex items-center justify-center text-white font-bold shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {firstName(name)[0]?.toUpperCase()}
    </div>
  );
}

// ─── Step Indicator ────────────────────────────────────────────────────────────

const STEP_LABELS = ['Symptoms', 'Review', 'Next steps'];
const STEP_MAP: Partial<Record<Screen, number>> = {
  reasoning: 1, submitting: 1, review: 1, notSubmitted: 1,
  nextSteps: 2, safetyNet: 2,
};

function StepIndicator({
  screen,
  maxReached,
  onNavigate,
}: {
  screen: Screen;
  maxReached: number;
  onNavigate?: (stepIndex: number) => void;
}) {
  const active = STEP_MAP[screen];
  if (active === undefined) return null;

  const isReview = active === 1;
  const isNextSteps = active === 2;

  const goPrevious = () => {
    if (isReview) {
      onNavigate?.(0);
    } else if (isNextSteps) {
      onNavigate?.(1);
    }
  };

  const goNext = () => {
    if (isReview) {
      onNavigate?.(2);
    }
  };

  return (
    <div className="bg-[#371A82] px-4 py-2.5">
      <div className="flex items-center justify-between gap-2">

        {/* Previous */}
        <button
          type="button"
          onClick={goPrevious}
          disabled={active === 0}
          className={`
            flex items-center gap-1.5 min-w-0
            px-2 py-1.5 rounded-lg
            text-xs font-medium
            transition-all
            ${active === 0
              ? "text-white/20 cursor-default"
              : "text-white/70 hover:bg-white/10 active:scale-95"}
          `}
          aria-label="Previous page"
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>

          <span>
            {isReview ? "Symptoms" : "Review"}
          </span>
        </button>

        {/* Current page + progress */}
        <div className="flex flex-col items-center min-w-0">
          <span className="text-white text-[11px] font-semibold">
            {isReview ? "Review" : "Next steps"}
          </span>

          <div className="flex items-center gap-1 mt-1">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isReview ? "bg-white" : "bg-[#8058DF]"
              }`}
            />
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isNextSteps ? "bg-white" : "bg-white/25"
              }`}
            />
          </div>
        </div>

        {/* Next */}
        <button
          type="button"
          onClick={goNext}
          disabled={!isReview}
          className={`
            flex items-center gap-1.5 min-w-0
            px-2 py-1.5 rounded-lg
            text-xs font-medium
            transition-all
            ${isReview
              ? "text-white hover:bg-white/10 active:scale-95"
              : "text-white/20 cursor-default"}
          `}
          aria-label="Next page"
        >
          <span>
            {isReview ? "Next steps" : "Current"}
          </span>

          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

      </div>
    </div>
  );
}


// ─── Welcome Screen ───────────────────────────────────────────────────────────

function SplashScreen({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 1800);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-white px-8">
      {/* Real logo file — see logo.png. In Figma Make, upload it via
          whatever image/asset upload control the editor provides (this is
          usually drag-and-drop onto the canvas or an "Add image" action in
          the sidebar, not something you can create by hand-typing a file
          path) — Figma Make should place it under src/imports/ to match
          this project's existing convention. If it lands somewhere else,
          update the import path above to match. */}
      <img src={logoImage} alt="wal — Your health journey, better supported." className="w-full max-w-[280px]" />
    </div>
  );
}

function WelcomeScreen({ onLogin, onRegister }: { onLogin: () => void; onRegister: () => void }) {
  return (
    <div className="flex-1 flex flex-col bg-[#F3F1FA] overflow-y-auto relative">
      {/* Decorative background watermarks — same treatment as Login/Register,
          purely visual, sits behind content at z-0. */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute -top-16 -left-20 w-56 h-56 rounded-full bg-[#8058DF]/10" />
        <svg className="absolute top-40 -right-10" width="200" height="200" viewBox="0 0 150 140" fill="none" opacity="0.12">
          <ellipse cx="71" cy="45" rx="23" ry="27" fill="#8058DF" />
          <ellipse cx="72" cy="43" rx="11" ry="15" fill="#F3F1FA" />
          <path d="M58 68 C50 76 46 88 54 98 C60 106 64 114 66 124" stroke="#8058DF" strokeWidth="9" strokeLinecap="round" fill="none" />
          <path d="M84 68 C94 76 98 88 90 98 C82 106 78 114 76 124" stroke="#8058DF" strokeWidth="9" strokeLinecap="round" fill="none" />
          <path d="M133 8 C129 3 120 4 118 11 C116 4 107 3 103 8 C99 14 103 21 118 30 C133 21 137 14 133 8 Z" fill="#8058DF" />
        </svg>
        <div className="absolute -bottom-20 -left-16 w-72 h-72 rounded-full bg-[#8058DF]/10" />
      </div>

      <div className="bg-white relative z-10">
        <div className="px-6 pt-8 pb-10 flex flex-col items-center text-center">
          <img src={logoImage} alt="wal — Your health journey, better supported." className="w-52 mb-2" />
          <p className="text-[#371A82]/70 text-sm leading-relaxed max-w-xs mt-3">
            Understand your symptoms. Get guidance checked against NHS NG12. Take the next step — safely, privately, at your own pace.
          </p>
        </div>
      </div>

      <div className="px-5 pt-6 flex flex-col gap-3 pb-8 relative z-10">
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-[#8058DF]/20 flex gap-3 items-start">
          <div className="w-10 h-10 rounded-full bg-[#8058DF]/10 flex items-center justify-center shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#371A82" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><rect x="9" y="11" width="6" height="5" rx="1"/><path d="M12 11V9"/>
            </svg>
          </div>
          <div>
            <p className="text-[#371A82] text-sm font-semibold">Confidential &amp; in your control</p>
            <p className="text-gray-500 text-xs mt-0.5 leading-relaxed">Nothing is shared with your GP until you explicitly give permission.</p>
          </div>
        </div>

        <button onClick={onLogin} className="w-full bg-[#371A82] text-white py-4 rounded-xl font-semibold text-sm hover:bg-[#2A1560] active:scale-[0.98] transition-all flex items-center justify-center gap-2">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
          </svg>
          I already have an account — log in
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
          </svg>
        </button>
        <button onClick={onRegister} className="w-full border-2 border-[#371A82] text-[#371A82] py-4 rounded-xl font-semibold text-sm hover:bg-[#371A82]/5 active:scale-[0.98] transition-all flex items-center justify-center gap-2">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#371A82" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>
          </svg>
          I'm new here — register
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#371A82" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
          </svg>
        </button>

        <div className="mt-2 bg-[#371A82]/6 rounded-xl p-3 flex gap-2.5 items-start">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#371A82" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5 opacity-70">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
          <p className="text-[10px] text-[#371A82]/70 text-left leading-relaxed">
            For medical emergencies, call <strong>999</strong> or go to your nearest A&amp;E immediately. Do not use this service in an emergency.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Login Screen ─────────────────────────────────────────────────────────────

function LoginScreen({ onLogin, onBack }: { onLogin: (u: User) => void; onBack: () => void }) {
  const [nhs, setNhs] = useState('');
  const [dob, setDob] = useState('');
  const [error, setError] = useState('');

  const [checking, setChecking] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nhs.trim() || !dob) { setError('Please fill in all fields.'); return; }
    setError('');
    setChecking(true);
    const result = await lookupPatient(nhs, dob);
    setChecking(false);
    if (result.status === 'notFound') {
      setError("We couldn't match those details. Please check your NHS number and date of birth.");
      return;
    }
    if (result.status === 'error') {
      setError("We couldn't reach the service just now. Please try again in a moment.");
      return;
    }
    onLogin({
      fullName: result.fullName,
      nhsNumber: nhs,
      dob,
      postcode: result.postcode ?? 'SE1 7PB',
      gpPractice: result.gpPractice,
      consent: true,
    });
  };

  return (
    <div className="flex-1 flex flex-col bg-[#F3F1FA] overflow-y-auto relative">
      <div className="bg-[#371A82] relative z-10">
        <div className="flex items-center gap-3 px-4 pb-4">
          <BackButton onBack={onBack} light />
          <h2 style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-white text-xl font-semibold">Log in</h2>
        </div>
      </div>

      {/* Decorative background watermarks — pure CSS shapes + the same ribbon
          geometry used elsewhere, at very low opacity. Purely decorative, so
          it sits behind everything (z-0) and never competes with content. */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute -top-16 -left-16 w-56 h-56 rounded-full bg-[#8058DF]/10" />
        <div className="absolute -bottom-24 -left-10 w-72 h-72 rounded-full bg-[#8058DF]/10" />
        <svg className="absolute -bottom-6 -right-6" width="220" height="220" viewBox="0 0 150 140" fill="none" opacity="0.12">
          <ellipse cx="71" cy="45" rx="23" ry="27" fill="#8058DF" />
          <ellipse cx="72" cy="43" rx="11" ry="15" fill="#F3F1FA" />
          <path d="M58 68 C50 76 46 88 54 98 C60 106 64 114 66 124" stroke="#8058DF" strokeWidth="9" strokeLinecap="round" fill="none" />
          <path d="M84 68 C94 76 98 88 90 98 C82 106 78 114 76 124" stroke="#8058DF" strokeWidth="9" strokeLinecap="round" fill="none" />
          <path d="M133 8 C129 3 120 4 118 11 C116 4 107 3 103 8 C99 14 103 21 118 30 C133 21 137 14 133 8 Z" fill="#8058DF" />
        </svg>
      </div>

      <div className="flex-1 flex flex-col px-6 pt-8 relative z-10">
        <div className="flex justify-center mb-6">
          <img src={logoImage} alt="wal" className="w-40" />
        </div>
        <div className="mb-8">
          <h1 style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-[#371A82] text-3xl font-bold mb-1.5">
            Welcome back
          </h1>
          <p className="text-gray-500 text-sm leading-relaxed">Enter your details to continue where you left off.</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-xs font-semibold text-[#371A82] mb-1.5 uppercase tracking-wide">NHS Number</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[#371A82]/40">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                </svg>
              </span>
              <input
                type="text"
                value={nhs}
                onChange={e => setNhs(sanitizeNhs(e.target.value))}
                placeholder="e.g. 485 777 3456"
                maxLength={12}
                className="w-full bg-white border border-[#8058DF]/25 rounded-xl pl-11 pr-4 py-3.5 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:border-[#371A82] focus:ring-2 focus:ring-[#371A82]/20 transition-all"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#371A82] mb-1.5 uppercase tracking-wide">Date of Birth</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[#371A82]/40 pointer-events-none">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                </svg>
              </span>
              <input
                type="date"
                value={dob}
                onChange={e => setDob(e.target.value)}
                className="w-full bg-white border border-[#8058DF]/25 rounded-xl pl-11 pr-4 py-3.5 text-sm text-gray-800 focus:outline-none focus:border-[#371A82] focus:ring-2 focus:ring-[#371A82]/20 transition-all"
              />
            </div>
          </div>
          {error && <p className="text-[#B3261E] text-xs font-medium">{error}</p>}
          <button type="submit" disabled={checking} className="w-full bg-[#371A82] text-white py-4 rounded-xl font-semibold text-sm mt-2 hover:bg-[#2A1560] active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-60">
            {checking ? 'Checking…' : 'Verify and continue'}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Register Screen ──────────────────────────────────────────────────────────

function RegisterScreen({ onRegister, onBack }: { onRegister: (u: User) => void; onBack: () => void }) {
  const [form, setForm] = useState({ fullName: '', nhsNumber: '', dob: '', postcode: '', gpPractice: '', consent: false });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (k: keyof typeof form, v: string | boolean) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.fullName || !form.nhsNumber || !form.dob || !form.postcode || !form.gpPractice) {
      setError('Please fill in all fields.'); return;
    }
    if (!form.consent) { setError('Please review and accept the consent statement to continue.'); return; }
    setError('');
    setSaving(true);
    const result = await registerPatient({ ...form, consent: true });
    setSaving(false);
    if (result.status === 'duplicate') {
      setError('That NHS number is already registered. Please log in instead.'); return;
    }
    if (result.status === 'invalid') { setError(result.message); return; }
    if (result.status === 'error') {
      setError("We couldn't reach the service just now. Please try again in a moment."); return;
    }
    onRegister({ ...form, gpPractice: result.gpPractice, consent: true });
  };

  return (
    <div className="flex-1 flex flex-col bg-[#F3F1FA] overflow-y-auto">
      <div className="bg-[#371A82]">
        <div className="flex items-center gap-3 px-4 pb-4">
          <BackButton onBack={onBack} light />
          <h2 style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-white text-xl font-semibold">Register</h2>
        </div>
      </div>

      <div className="flex-1 flex flex-col px-6 pt-8">
        <div className="flex justify-center mb-6">
          <img src={logoImage} alt="wal" className="w-32" />
        </div>
        <div className="mb-7">
          <h1 style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-[#371A82] text-2xl font-semibold mb-1.5">
            Create your account
          </h1>
          <p className="text-gray-500 text-sm leading-relaxed">A few details so we can connect you to the right GP practice.</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          {([
            ['fullName', 'Full name', 'text', 'e.g. Priya Sharma'],
            ['nhsNumber', 'NHS Number', 'text', 'e.g. 485 777 3456'],
            ['dob', 'Date of birth', 'date', ''],
            ['postcode', 'Postcode', 'text', 'e.g. SE1 7PB'],
            ['gpPractice', 'GP Practice', 'text', 'e.g. Waterloo Health Centre'],
          ] as const).map(([key, label, type, placeholder]) => (
            <div key={key}>
              <label className="block text-xs font-semibold text-[#371A82] mb-1.5 uppercase tracking-wide">{label}</label>
              <input
                type={type}
                value={form[key] as string}
                onChange={e => set(key, key === 'nhsNumber' ? sanitizeNhs(e.target.value) : e.target.value)}
                placeholder={placeholder}
                maxLength={key === 'nhsNumber' ? 12 : undefined}
                className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3.5 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:border-[#371A82] focus:ring-2 focus:ring-[#371A82]/20 transition-all"
              />
            </div>
          ))}

          <div className="bg-[#371A82]/6 rounded-xl p-4 flex gap-3 items-start mt-2">
            <input
              type="checkbox"
              id="consent"
              checked={form.consent}
              onChange={e => set('consent', e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-[#371A82] shrink-0 cursor-pointer"
            />
            <label htmlFor="consent" className="text-xs text-[#371A82]/80 leading-relaxed cursor-pointer">
              I consent to my symptom information being shared with my registered GP practice, when I explicitly choose to share it through this app.
            </label>
          </div>

          {error && <p className="text-[#B3261E] text-xs font-medium">{error}</p>}

          <button type="submit" disabled={saving} className="w-full bg-[#371A82] text-white py-4 rounded-xl font-semibold text-sm mt-2 hover:bg-[#2A1560] active:scale-[0.98] transition-all disabled:opacity-60">
            {saving ? 'Creating your account…' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Home Screen ──────────────────────────────────────────────────────────────

function HomeScreen({
  user, history, onNewChat, onProfile, onHistory, onSettings, onLogout,
}: {
  user: User; history: HistoryEntry[]; onNewChat: () => void; onProfile: () => void; onHistory: () => void; onSettings: () => void; onLogout: () => void;
}) {
  const [showMenu, setShowMenu] = useState(false);

  return (
    <div className="flex-1 flex flex-col bg-[#F3F1FA] overflow-y-auto relative">
      <div className="bg-gradient-to-br from-[#371A82] to-[#6B48C7] rounded-b-[2.5rem] relative overflow-hidden">
        <div className="absolute -bottom-10 -right-6 w-32 h-32 rounded-full bg-white/5" />
        <div className="absolute bottom-4 right-16 w-16 h-16 rounded-full bg-white/5" />
        <div className="flex items-center justify-between px-5 pb-7 pt-2 relative">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center shrink-0 overflow-hidden">
              <img src={logoMark} alt="" className="w-6 h-6 object-contain" />
            </div>
            <p style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-white text-xl font-bold leading-none">OncoWay</p>
          </div>
          <button onClick={() => setShowMenu(true)} className="w-10 h-10 rounded-full bg-white/15 flex items-center justify-center hover:bg-white/25 transition-all shrink-0" aria-label="Open menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Decorative background watermark, bottom-left, same treatment as
          Welcome/Login/Register. */}
      <div className="absolute inset-x-0 bottom-0 h-64 overflow-hidden pointer-events-none z-0">
        <svg className="absolute -bottom-4 -left-6" width="220" height="220" viewBox="0 0 150 140" fill="none" opacity="0.12">
          <ellipse cx="71" cy="45" rx="23" ry="27" fill="#8058DF" />
          <ellipse cx="72" cy="43" rx="11" ry="15" fill="#F3F1FA" />
          <path d="M58 68 C50 76 46 88 54 98 C60 106 64 114 66 124" stroke="#8058DF" strokeWidth="9" strokeLinecap="round" fill="none" />
          <path d="M84 68 C94 76 98 88 90 98 C82 106 78 114 76 124" stroke="#8058DF" strokeWidth="9" strokeLinecap="round" fill="none" />
          <path d="M133 8 C129 3 120 4 118 11 C116 4 107 3 103 8 C99 14 103 21 118 30 C133 21 137 14 133 8 Z" fill="#8058DF" />
        </svg>
      </div>

      <div className="px-5 py-5 flex-1 flex flex-col justify-center gap-4 relative z-10">
        {/* The greeting sits with the cards in the centred group, filling what was dead space. */}
        <div className="text-center mb-2">
          <div className="flex items-center justify-center gap-2">
            <h2 style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-[#371A82] text-3xl font-bold">
              Hi, {firstName(user.fullName)}
            </h2>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="#8058DF" stroke="none">
              <path d="M12 21s-7-4.35-9.5-8.5C1 9 2.5 5.5 6 5c2-.3 3.7.7 6 3 2.3-2.3 4-3.3 6-3 3.5.5 5 4 3.5 7.5C19 16.65 12 21 12 21z"/>
            </svg>
          </div>
          <p className="text-gray-500 text-sm mt-1.5">How are you feeling today?</p>
        </div>

        <button
          onClick={onNewChat}
          className="w-full bg-gradient-to-br from-[#371A82] to-[#6B48C7] rounded-2xl p-5 flex items-center gap-4 shadow-lg shadow-[#371A82]/20 hover:opacity-95 active:scale-[0.98] transition-all text-left relative overflow-hidden"
        >
          <div className="absolute -top-6 -right-6 w-20 h-20 rounded-full bg-white/5" />
          <div className="w-12 h-12 rounded-xl bg-white/15 flex items-center justify-center shrink-0 relative">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              <line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
            </svg>
          </div>
          <div className="flex-1 relative">
            <p className="text-white font-semibold text-base leading-tight">Start a new chat</p>
            <p className="text-white/60 text-xs mt-0.5 leading-relaxed">Describe a symptom and get NHS NG12 guidance</p>
          </div>
          <div className="w-9 h-9 rounded-full bg-white/15 flex items-center justify-center shrink-0 relative">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
            </svg>
          </div>
        </button>

        <button onClick={onHistory} className="w-full bg-white rounded-2xl p-4 flex items-center justify-between shadow-sm hover:shadow-md active:scale-[0.98] transition-all text-left">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#F3F1FA] border border-[#371A82]/20 flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#371A82" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="12 8 12 12 14 14"/><circle cx="12" cy="12" r="10"/>
              </svg>
            </div>
            <div>
              <p className="text-[#371A82] font-semibold text-sm">Your past chats</p>
              <p className="text-gray-400 text-xs mt-0.5">{history.length} conversation{history.length !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#371A82" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6"/>
          </svg>
        </button>

        <div className="bg-white rounded-2xl p-4 flex items-center justify-between gap-3 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-green-500 shrink-0"></div>
            <p className="text-xs text-gray-500 leading-relaxed">
              Consent to share with GP: <span className={`font-semibold ${user.consent ? 'text-[#371A82]' : 'text-gray-400'}`}>{user.consent ? 'Given' : 'Not given'}</span>
            </p>
          </div>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#371A82" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>
          </svg>
        </div>
      </div>

      {showMenu && (
        <div className="absolute inset-0 bg-black/40 z-40 flex justify-end" onClick={() => setShowMenu(false)}>
          <div className="w-[78%] max-w-[280px] h-full bg-white shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="bg-[#371A82] px-5 pt-6 pb-5 flex items-center gap-3">
              <Avatar name={user.fullName} size={44} />
              <div className="min-w-0">
                <p className="text-white font-semibold text-sm truncate">{user.fullName}</p>
                <p className="text-white/60 text-xs mt-0.5 truncate">{user.gpPractice}</p>
              </div>
            </div>

            <div className="flex-1 flex flex-col py-2">
              <button
                onClick={() => { setShowMenu(false); onProfile(); }}
                className="flex items-center gap-3 px-5 py-3.5 hover:bg-[#F3F1FA] transition-all text-left"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#371A82" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                </svg>
                <span className="text-sm font-medium text-gray-700">Account details</span>
              </button>

              <button
                onClick={() => { setShowMenu(false); onHistory(); }}
                className="flex items-center gap-3 px-5 py-3.5 hover:bg-[#F3F1FA] transition-all text-left"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#371A82" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="12 8 12 12 14 14"/><circle cx="12" cy="12" r="10"/>
                </svg>
                <span className="text-sm font-medium text-gray-700">Past chats</span>
              </button>

              <button
                onClick={() => { setShowMenu(false); onSettings(); }}
                className="flex items-center gap-3 px-5 py-3.5 hover:bg-[#F3F1FA] transition-all text-left"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#371A82" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
                <span className="text-sm font-medium text-gray-700">Settings</span>
              </button>
            </div>

            <div className="px-5 py-4 border-t border-gray-100">
              <button
                onClick={() => { setShowMenu(false); onLogout(); }}
                className="w-full flex items-center gap-3 py-2 text-left"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#B3261E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
                <span className="text-sm font-medium text-[#B3261E]">Log out</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Settings Screen ──────────────────────────────────────────────────────────

function Toggle({ checked, onChange, label, hint, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 py-3 ${disabled ? 'opacity-50' : ''}`}>
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-800">{label}</p>
        {hint && <p className="text-xs text-gray-500 mt-0.5 leading-snug">{hint}</p>}
      </div>
      <button
        type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative w-12 h-7 rounded-full shrink-0 transition-colors ${checked ? 'bg-[#371A82]' : 'bg-gray-300'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  );
}

function SettingsScreen({ settings, user, onChange, onConsentChange, onReset, onClearHistory, historyCount, onBack }: {
  settings: Settings; user: User; onChange: (patch: Partial<Settings>) => void; onConsentChange: (v: boolean) => void; onReset: () => void;
  onClearHistory: () => void; historyCount: number; onBack: () => void;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  const sizes: { id: TextSize; label: string }[] = [
    { id: 'small', label: 'Small' }, { id: 'default', label: 'Default' }, { id: 'large', label: 'Large' }, { id: 'xlarge', label: 'Extra large' },
  ];
  const card = 'bg-white rounded-2xl px-4 py-3 shadow-sm';
  const heading = 'text-[11px] font-bold text-[#371A82] uppercase tracking-[0.08em] mb-1 mt-2 px-1';

  return (
    <div className="flex-1 flex flex-col bg-[#F3F1FA] overflow-y-auto">
      <div className="bg-[#371A82]">
        <div className="flex items-center gap-3 px-4 pb-5">
          <BackButton onBack={onBack} light />
          <h2 style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-white text-xl font-semibold">Settings</h2>
        </div>
      </div>

      <div className="px-4 py-4 flex flex-col gap-3">
        <p className={heading}>Voice</p>
        <div className={card}>
          {!voiceInputSupported && (
            <p className="text-xs text-[#B3261E] pb-2 leading-snug">Voice input isn't supported in this browser. Try Chrome, Edge or Safari.</p>
          )}
          <label className="block py-2">
            <span className="text-sm font-medium text-gray-800">Language for speaking and listening</span>
            <select
              value={settings.voiceLang}
              onChange={e => onChange({ voiceLang: e.target.value })}
              className="mt-2 w-full bg-[#F3F1FA] rounded-xl px-3 py-3 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-[#371A82]/30"
            >
              {VOICE_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </label>
          <div className="h-px bg-gray-100" />
          <Toggle
            checked={settings.autoSendVoice} onChange={v => onChange({ autoSendVoice: v })}
            label="Send automatically when I stop speaking"
            hint="Off: your words appear in the box so you can check them before sending."
            disabled={!voiceInputSupported}
          />
          <div className="h-px bg-gray-100" />
          <Toggle
            checked={settings.readAloud} onChange={v => { onChange({ readAloud: v }); if (!v) stopSpeaking(); }}
            label="Read replies aloud"
            hint={readAloudSupported ? 'The chatbot speaks each new reply.' : "Your browser can't read text aloud."}
            disabled={!readAloudSupported}
          />
        </div>

        <p className={heading}>Display</p>
        <div className={card}>
          <p className="text-sm font-medium text-gray-800 py-2">Text size</p>
          <div className="grid grid-cols-4 gap-2 pb-2" role="radiogroup" aria-label="Text size">
            {sizes.map(s => (
              <button
                key={s.id} type="button" role="radio" aria-checked={settings.textSize === s.id}
                onClick={() => onChange({ textSize: s.id })}
                className={`rounded-xl py-2.5 text-xs font-semibold transition-all ${settings.textSize === s.id ? 'bg-[#371A82] text-white' : 'bg-[#F3F1FA] text-[#371A82]'}`}
              >{s.label}</button>
            ))}
          </div>
          <div className="h-px bg-gray-100" />
          <Toggle checked={settings.highContrast} onChange={v => onChange({ highContrast: v })} label="High contrast" hint="Darker text and stronger colours." />
        </div>

        <p className={heading}>Privacy and data</p>
        <div className={card}>
          <Toggle
            checked={user.consent} onChange={onConsentChange}
            label="Allow sharing summaries with your GP"
            hint={`Nothing is sent to ${user.gpPractice} until you choose to submit. Turn this off and you won't be able to submit summaries.`}
          />
          <div className="h-px bg-gray-100" />
          <div className="py-3">
            <p className="text-sm font-medium text-gray-800">Chat history</p>
            <p className="text-xs text-gray-500 mt-0.5 mb-2 leading-snug">{historyCount} saved conversation{historyCount === 1 ? '' : 's'} in this session.</p>
            {!confirmClear ? (
              <button type="button" disabled={historyCount === 0} onClick={() => setConfirmClear(true)}
                className="text-sm font-semibold text-[#B3261E] disabled:opacity-40">Clear my chat history</button>
            ) : (
              <div className="flex items-center gap-4">
                <button type="button" onClick={() => { onClearHistory(); setConfirmClear(false); }} className="text-sm font-semibold text-[#B3261E]">Yes, clear it</button>
                <button type="button" onClick={() => setConfirmClear(false)} className="text-sm font-semibold text-gray-500">Cancel</button>
              </div>
            )}
          </div>
        </div>

        <p className={heading}>About</p>
        <div className={card}>
          <p className="text-sm text-gray-700 leading-relaxed py-1">OncoWay helps you understand your symptoms against NHS NICE NG12 guidance. It does not diagnose. Your GP makes the final assessment.</p>
          <div className="h-px bg-gray-100 my-2" />
          <p className="text-sm text-gray-700 leading-relaxed py-1">In an emergency call <strong>999</strong> or go to A&amp;E. For urgent advice call <strong>111</strong>. If you feel overwhelmed, Samaritans are free on <strong>116 123</strong>.</p>
        </div>

        <button type="button" onClick={onReset} className="mt-1 mb-4 py-3 text-sm font-semibold text-[#371A82] underline underline-offset-2">Reset settings to default</button>
      </div>
    </div>
  );
}

// ─── Profile Screen ───────────────────────────────────────────────────────────

function ProfileScreen({ user, history, onBack, onHistory, onLogout }: {
  user: User; history: HistoryEntry[]; onBack: () => void; onHistory: () => void; onLogout: () => void;
}) {
  return (
    <div className="flex-1 flex flex-col bg-[#F3F1FA] overflow-y-auto">
      <div className="bg-[#371A82]">
        <div className="flex items-center gap-3 px-4 pb-5">
          <BackButton onBack={onBack} light />
          <h2 style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-white text-xl font-semibold">Account details</h2>
        </div>
        <div className="flex flex-col items-center pb-6">
          <Avatar name={user.fullName} size={64} />
          <p className="text-white text-lg font-semibold mt-2">{user.fullName}</p>
          <p className="text-white/60 text-xs mt-0.5">{user.gpPractice}</p>
        </div>
      </div>

      <div className="px-5 py-5 flex flex-col gap-3">
        {[
          ['NHS Number', user.nhsNumber],
          ['Date of Birth', user.dob],
          ['Postcode', user.postcode],
          ['GP Practice', user.gpPractice],
          ['Consent status', user.consent ? 'Given — sharing permitted' : 'Not given'],
        ].map(([label, value]) => (
          <div key={label} className="bg-white rounded-xl px-4 py-3 flex justify-between items-center gap-3 shadow-sm">
            <span className="text-xs text-gray-400 font-medium shrink-0">{label}</span>
            <span className={`text-sm font-semibold text-right truncate ${label === 'Consent status' && user.consent ? 'text-[#371A82]' : 'text-gray-700'}`}>{value}</span>
          </div>
        ))}

        <button onClick={onHistory} className="w-full bg-white rounded-xl px-4 py-3.5 flex items-center justify-between shadow-sm hover:shadow-md transition-all">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#371A82" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="12 8 12 12 14 14"/><circle cx="12" cy="12" r="10"/>
            </svg>
            <span className="text-sm font-semibold text-[#371A82]">Past chats ({history.length})</span>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#371A82" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18l6-6-6-6"/>
          </svg>
        </button>

        <button onClick={onLogout} className="w-full border border-[#B3261E]/30 bg-[#B3261E]/5 text-[#B3261E] rounded-xl px-4 py-3.5 font-semibold text-sm hover:bg-[#B3261E]/10 transition-all mt-2">
          Log out
        </button>
      </div>
    </div>
  );
}

// ─── Chat Screen ──────────────────────────────────────────────────────────────

function ChatScreen({ user, settings, onEmergency, onComplete, onBack, initialSession, onContinue }: {
  user: User;
  settings: Settings;
  onEmergency: (msgs: ChatMessage[]) => void;
  onComplete: (session: SessionData) => void;
  onBack: () => void;
  initialSession?: SessionData | null;
  onContinue?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialSession?.messages ?? []);
  const [inputText, setInputText] = useState('');
  const [botTyping, setBotTyping] = useState(false);
  const [phase, setPhase] = useState<ChatPhase>(initialSession ? 'done' : 'initial');
  const [category, setCategory] = useState<SymptomCategory | null>(initialSession?.category ?? null);
  const [userInput, setUserInput] = useState(initialSession?.userInput ?? '');
  const [answers, setAnswers] = useState<string[]>(initialSession?.answers ?? []);
  /** Set when the patient picks 'Something else', so they can type instead of choosing. */
  const [freeText, setFreeText] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const phaseRef = useRef<ChatPhase>('initial');
  const categoryRef = useRef<SymptomCategory | null>(null);
  const answersRef = useRef<string[]>([]);
  const userInputRef = useRef('');
  const convoRef = useRef<{ role: 'user' | 'assistant'; content: string }[]>([]);

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { categoryRef.current = category; }, [category]);
  useEffect(() => { answersRef.current = answers; }, [answers]);
  useEffect(() => { userInputRef.current = userInput; }, [userInput]);

  // ── Voice input and read-aloud ──
  const [listening, setListening] = useState(false);
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);
  const voiceRef = useRef<VoiceSession | null>(null);
  const processInputRef = useRef<(t: string) => void>(() => {});
  const spokenCount = useRef(messages.length);

  const VOICE_MESSAGES: Record<VoiceError, string> = {
    blocked: 'Microphone access is blocked. Allow it in your browser settings, then try again.',
    'no-speech': "I didn't hear anything. Tap the microphone and try again.",
    network: "Voice input couldn't reach the speech service. Check your connection, or type instead.",
    unsupported: "Voice input isn't supported in this browser. Try Chrome, Edge or Safari, or type instead.",
    other: "Voice input didn't work that time. You can type instead.",
  };

  const toggleMic = () => {
    if (listening) { voiceRef.current?.stop(); return; }
    setVoiceMsg(null);
    stopSpeaking();
    setListening(true);
    voiceRef.current = startListening({
      lang: settings.voiceLang,
      onText: t => setInputText(t),
      onFinal: t => {
        if (settings.autoSendVoice) { setInputText(''); processInputRef.current(t); }
        else setInputText(t);
      },
      onError: e => setVoiceMsg(VOICE_MESSAGES[e]),
      onEnd: () => { setListening(false); inputRef.current?.focus(); },
    });
  };

  useEffect(() => () => { voiceRef.current?.stop(); stopSpeaking(); }, []);

  // Read the chatbot's newest reply aloud when that setting is on.
  useEffect(() => {
    if (messages.length <= spokenCount.current) return;
    const last = messages[messages.length - 1];
    spokenCount.current = messages.length;
    if (settings.readAloud && last?.role === 'bot') speak(last.text, settings.voiceLang);
  }, [messages]);

  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  useEffect(() => { scrollToBottom(); }, [messages, botTyping]);

  const addBotMsg = useCallback((text: string, quickReplies?: string[]) => {
    setBotTyping(true);
    const delay = 600 + Math.random() * 500;
    setTimeout(() => {
      setMessages(prev => [...prev, { id: genId(), role: 'bot', text, quickReplies, time: nowTime() }]);
      setBotTyping(false);
    }, delay);
  }, []);

  const addUserMsg = (text: string) => {
    setMessages(prev => [...prev, { id: genId(), role: 'user', text, time: nowTime() }]);
  };

  useEffect(() => {
    // Only greet on a genuinely new chat — a restored session already has its
    // full transcript in `messages`, and re-greeting would duplicate it.
    if (initialSession) return;
    const timeout = setTimeout(() => {
      addBotMsg(`Hello, ${firstName(user.fullName)}. I'm here to help you understand your symptoms and check them against NHS NG12 guidance.\n\nPlease describe in your own words what you've been noticing — there's no right or wrong way to explain it.`);
    }, 400);
    return () => clearTimeout(timeout);
  }, []);

  const processInput = async (text: string) => {
    const currentPhase = phaseRef.current;
    const currentCategory = categoryRef.current;
    const currentAnswers = answersRef.current;
    const currentUserInput = userInputRef.current;

    if (currentPhase === 'initial' || currentPhase === 'clarify') {
      if (isEmergency(text)) {
        addUserMsg(text);
        setTimeout(() => onEmergency([...messages, { id: genId(), role: 'user', text, time: nowTime() }]), 200);
        return;
      }
      // Backend emergency/crisis screen: catches wording the local keyword list misses
      // (e.g. suicidal thoughts). Fails soft, so the scripted flow still works offline.
      setBotTyping(true);
      const screened = await screenMessage(text);
      setBotTyping(false);
      if (screened?.safety) {
        addUserMsg(text);
        if (screened.safety === 'crisis' || screened.safety === 'abdomen') {
          addBotMsg(screened.answer);
        } else {
          setTimeout(() => onEmergency([...messages, { id: genId(), role: 'user', text, time: nowTime() }]), 200);
        }
        return;
      }
      // Look at everything the patient has said so far: a later answer may reveal a known category.
      const convo = convoRef.current;
      // Joined as sentences so the Review screen reads naturally.
      const priorUser = convo.filter(m => m.role === 'user').map(m => m.content);
      const allUserText = [...priorUser, text]
        .map(t => t.trim().replace(/[.!?\s]+$/, ''))
        .join('. ') + '.';
      const firstMessage = priorUser[0] ?? text;
      const followUps = priorUser.length ? [...priorUser.slice(1), text] : [];
      const matched = matchCategory(firstMessage) || matchCategory(stripNegated(followUps.join('. ')));
      if (matched) {
        addUserMsg(text);
        setUserInput(allUserText);
        setCategory(matched);
        setPhase('q0');
        setTimeout(() => addBotMsg(
          `Thank you. I've recognised this relates to "${matched.label}" — a symptom category covered by NHS NG12 guidance.\n\nI'll ask a few short questions to build a clearer picture. Please use the options below.`,
        ), 300);
        setTimeout(() => addBotMsg(matched.followUpQuestions[0].question, withSomethingElse(matched.followUpQuestions[0].options)), 1700);
        return;
      }

      addUserMsg(text);
      setPhase('clarify');
      const withUser = [...convo, { role: 'user' as const, content: text }];
      const userTurns = withUser.filter(m => m.role === 'user').length;
      // Only recorded once we know it's a symptom: an off-topic message must not reach the summary.
      const keepTurn = () => { setUserInput(allUserText); convoRef.current = withUser; };

      if (userTurns > MAX_MODEL_QUESTIONS) {
        keepTurn();
        // Enough facts gathered: wrap up and move on to the summary/review flow.
        setPhase('done');
        addBotMsg("Thank you — that gives me a clear enough picture. I'll put together a summary of what you've told me and check it against NHS NG12 guidance.");
        const finalMessages = [...messages, { id: genId(), role: 'user' as const, text, time: nowTime() }];
        setTimeout(async () => {
          // Does anything in NG12 match? If not, this is a safety-netting outcome rather than a GP referral.
          const plan = await getPreparation(user.nhsNumber, allUserText);
          onComplete({
            category: plan?.outcome === 'safetynet' ? null : buildGeneralCategory(allUserText),
            userInput: allUserText,
            answers: withUser.filter(m => m.role === 'user').slice(1).map(m => m.content),
            matchedNG12: false,
            messages: finalMessages,
            submittedToGP: false,
          });
        }, 2400);
        return;
      }

      // Ask the fine-tuned model for the next relevant question, giving it the conversation so far.
      setBotTyping(true);
      const reply = await askSlm(user.nhsNumber, text, convo);
      setBotTyping(false);
      if (reply?.scope === 'out') {
        // Not about their health. Say what OncoWay is for and leave the intake exactly where it was.
        setPhase(currentPhase);
        addBotMsg(reply.answer);
      } else if (reply?.done) {
        // The guided question set is exhausted, so there is nothing useful left to ask.
        keepTurn();
        setPhase('done');
        addBotMsg(reply.answer);
        const finalMessages = [...messages, { id: genId(), role: 'user' as const, text, time: nowTime() }];
        setTimeout(async () => {
          const plan = await getPreparation(user.nhsNumber, allUserText);
          onComplete({
            category: plan?.outcome === 'safetynet' ? null : buildGeneralCategory(allUserText),
            userInput: allUserText,
            answers: withUser.filter(m => m.role === 'user').slice(1).map(m => m.content),
            matchedNG12: false,
            messages: finalMessages,
            submittedToGP: false,
          });
        }, 2400);
      } else if (reply?.answer) {
        keepTurn();
        convoRef.current = [...withUser, { role: 'assistant' as const, content: reply.answer }];
        addBotMsg(reply.answer);
      } else if (userTurns === 1) {
        keepTurn();
        addBotMsg("Thank you for sharing that. Can you say a little more about what you've noticed physically? For example, where exactly, and when did you first notice it?");
      } else {
        keepTurn();
        setPhase('noMatch');
        addBotMsg(
          "I'm having trouble checking your description against NG12 guidance just now, so I can't say whether it matches a referral pattern.\n\nIf one of these is closer to what you're experiencing, choose it and I'll ask about that instead — otherwise choose the last option and I'll pass on what you've already told me.",
          [...SYMPTOM_CATEGORIES.slice(0, 5).map(c => c.label), NONE_OF_THESE]
        );
      }
    }
  };

  processInputRef.current = processInput;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = inputText.trim();
    if (!text || botTyping) return;
    setInputText('');
    // A typed reply to a fixed-answer question is recorded as that question's answer, so the
    // patient's own wording carries through to the summary instead of a chosen label.
    if (freeText && ['q0', 'q1', 'q2'].includes(phaseRef.current)) {
      setFreeText(false);
      handleQuickReply(text);
    } else {
      processInput(text);
    }
    inputRef.current?.focus();
  };

  const handleQuickReply = (option: string) => {
    if (botTyping) return;
    const currentPhase = phaseRef.current;
    const currentCategory = categoryRef.current;
    const currentAnswers = answersRef.current;
    const currentUserInput = userInputRef.current;

    addUserMsg(option);

    if (currentPhase === 'noMatch') {
      if (option === NONE_OF_THESE) {
        setPhase('done');
        addBotMsg("That's fine — I'll summarise what you've told me in your own words and check it against NHS NG12 guidance.");
        const finalMessages = [...messages, { id: genId(), role: 'user' as const, text: option, time: nowTime() }];
        setTimeout(async () => {
          const plan = await getPreparation(user.nhsNumber, currentUserInput);
          onComplete({
            category: plan?.outcome === 'safetynet' ? null : buildGeneralCategory(currentUserInput),
            userInput: currentUserInput,
            answers: convoRef.current.filter(m => m.role === 'user').slice(1).map(m => m.content),
            matchedNG12: false,
            messages: finalMessages,
            submittedToGP: false,
          });
        }, 2400);
        return;
      }
      const matched = SYMPTOM_CATEGORIES.find(c => c.label === option);
      if (matched) {
        setCategory(matched);
        setPhase('q0');
        setTimeout(() => addBotMsg(matched.followUpQuestions[0].question, withSomethingElse(matched.followUpQuestions[0].options)), 700);
      }
      return;
    }

    if (option === SOMETHING_ELSE) {
      // Hand the turn back to the patient rather than recording a fixed answer.
      setFreeText(true);
      setTimeout(() => addBotMsg('Of course — please describe it in your own words.'), 500);
      return;
    }

    const qIndex = currentPhase === 'q0' ? 0 : currentPhase === 'q1' ? 1 : 2;
    const newAnswers = [...currentAnswers, option];
    setAnswers(newAnswers);

    if (newAnswers.length === 3 && currentCategory) {
      setPhase('done');
      addBotMsg('Thank you for those answers. Let me put together a summary and check it against NHS NG12 guidance…');
      const finalMessages = [...messages, { id: genId(), role: 'user' as const, text: option, time: nowTime() }];
      setTimeout(() => {
        onComplete({
          category: currentCategory,
          userInput: currentUserInput,
          answers: newAnswers,
          matchedNG12: true,
          messages: finalMessages,
          submittedToGP: false,
        });
      }, 1800);
    } else if (currentCategory) {
      const nextPhase = qIndex === 0 ? 'q1' : 'q2';
      setPhase(nextPhase as ChatPhase);
      setTimeout(() => addBotMsg(
        currentCategory.followUpQuestions[qIndex + 1].question,
        withSomethingElse(currentCategory.followUpQuestions[qIndex + 1].options)
      ), 700);
    }
  };

  // 'Something else' unlocks the text box on a question that otherwise only takes fixed answers.
  const isInputPhase = phase === 'initial' || phase === 'clarify' || freeText;
  const lastMsg = messages[messages.length - 1];
  const showQuickReplies = lastMsg?.role === 'bot' && lastMsg.quickReplies && !botTyping;
  // A restored session is already finished — this is what lets you go forward
  // again after stepping back here, instead of the chat just sitting inert.
  const isRestoredAndDone = !!initialSession && phase === 'done';

  return (
    <div className="flex-1 flex flex-col bg-[#F3F1FA] overflow-hidden relative">
      <div className="bg-gradient-to-br from-[#371A82] to-[#6B48C7] rounded-b-[2rem] relative overflow-hidden shrink-0">
        <div className="absolute -bottom-8 -right-4 w-28 h-28 rounded-full bg-white/5" />
        <div className="flex items-center gap-3 px-4 pb-5 pt-2 relative">
          <BackButton onBack={onBack} light />
          <div className="w-11 h-11 rounded-full bg-white flex items-center justify-center shrink-0 overflow-hidden">
            <img src={logoMark} alt="" className="w-7 h-7 object-contain" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <p style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-white font-bold text-base leading-none">OncoWay</p>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="#C4B5F5" stroke="none">
                <path d="M12 21s-7-4.35-9.5-8.5C1 9 2.5 5.5 6 5c2-.3 3.7.7 6 3 2.3-2.3 4-3.3 6-3 3.5.5 5 4 3.5 7.5C19 16.65 12 21 12 21z"/>
              </svg>
            </div>
            <p className="text-white/60 text-[11px] mt-1">
              Symptom checker
              {!apiConfigured && (
                <span className="ml-2 rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
                  Offline demo — NG12 service not connected
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-3 flex flex-col gap-3">
        <div className="flex justify-center mb-1">
          <span className="bg-[#8058DF]/12 text-[#4A3080] text-[11px] font-semibold px-3 py-1 rounded-full">Today</span>
        </div>

        {messages.map(msg => (
          <div key={msg.id} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
            <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} gap-2 w-full`}>
              {msg.role === 'bot' && (
                <div className="w-7 h-7 rounded-full bg-[#8058DF]/15 flex items-center justify-center shrink-0 mt-0.5 overflow-hidden">
                  <img src={logoMark} alt="" className="w-4 h-4 object-contain" />
                </div>
              )}
              <div
                className={`max-w-[78%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-line ${
                  msg.role === 'user'
                    ? 'bg-[#371A82] text-white rounded-tr-sm'
                    : 'bg-white text-gray-800 rounded-tl-sm shadow-sm'
                }`}
              >
                {msg.text}
              </div>
            </div>
            {msg.time && (
              <span className={`text-[10px] text-gray-400 mt-1 ${msg.role === 'bot' ? 'ml-9' : 'mr-1'}`}>{msg.time}</span>
            )}
          </div>
        ))}

        {botTyping && (
          <div className="flex justify-start gap-2">
            <div className="w-7 h-7 rounded-full bg-[#8058DF]/15 flex items-center justify-center shrink-0 overflow-hidden">
              <img src={logoMark} alt="" className="w-4 h-4 object-contain" />
            </div>
            <div className="bg-white px-4 py-3 rounded-2xl rounded-tl-sm shadow-sm flex items-center gap-1.5">
              {[0, 1, 2].map(i => (
                <div key={i} className="w-2 h-2 rounded-full bg-[#371A82]/40 animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
              ))}
            </div>
          </div>
        )}

        {showQuickReplies && (
          <div className="flex flex-wrap gap-2 pl-9">
            {lastMsg.quickReplies!.map(opt => (
              <button
                key={opt}
                onClick={() => handleQuickReply(opt)}
                className="bg-white border border-[#371A82]/25 text-[#371A82] text-xs font-medium px-3.5 py-2 rounded-full hover:bg-[#371A82] hover:text-white hover:border-[#371A82] transition-all active:scale-95"
              >
                {opt}
              </button>
            ))}
          </div>
        )}

        {messages.length <= 1 && !botTyping && (
          <div className="flex-1 flex flex-col items-center justify-center text-center min-h-[300px] -mt-1">

            {/* Center brand illustration */}
            <div className="relative w-[158px] h-[158px] flex items-center justify-center mb-3">

              <div
                className="
                  absolute
                  inset-0
                  rounded-full
                  bg-[#8058DF]/10
                "
              />

              <div
                className="
                  absolute
                  inset-[10px]
                  rounded-full
                  bg-[#8058DF]/[0.04]
                "
              />

              <img
                src={logoMark}
                alt="OncoWay"
                className="relative w-[76px] h-[76px] object-contain"
              />

              {/* Decorative lines */}
              <div className="absolute left-2 top-1/2 -translate-y-1/2 flex flex-col gap-1.5 opacity-45">
                <span className="block w-3 h-0.5 rounded-full bg-[#8058DF]" />
                <span className="block w-5 h-0.5 rounded-full bg-[#8058DF]" />
                <span className="block w-3 h-0.5 rounded-full bg-[#8058DF]" />
              </div>

              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex flex-col gap-1.5 opacity-45 items-end">
                <span className="block w-3 h-0.5 rounded-full bg-[#8058DF]" />
                <span className="block w-5 h-0.5 rounded-full bg-[#8058DF]" />
                <span className="block w-3 h-0.5 rounded-full bg-[#8058DF]" />
              </div>

            </div>

            <p
              style={{
                fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif",
              }}
              className="
                text-[#371A82]
                text-[17px]
                leading-tight
                font-bold
              "
            >
              Your health matters.
            </p>

            <p className="text-gray-400 text-sm mt-1">
              We're here to help.
            </p>

          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {isRestoredAndDone ? (
        <div className="p-4 bg-white border-t border-gray-100">
          <button
            onClick={onContinue}
            className="w-full bg-[#371A82] text-white py-3.5 rounded-xl font-semibold text-sm hover:bg-[#2A1560] active:scale-[0.98] transition-all"
          >
            {initialSession?.submittedToGP ? 'Continue to review' : 'Continue where I left off'}
          </button>
        </div>
      ) : (
        <div className="bg-white border-t border-gray-100">
        {voiceMsg && <p role="alert" className="px-4 pt-2 text-xs text-[#B3261E]">{voiceMsg}</p>}
        <form onSubmit={handleSubmit} className="flex items-center gap-2 px-4 pt-3 pb-4">
          <div className="flex-1 relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[#8058DF]/60 pointer-events-none">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2 L14 8 L20 8 L15 12 L17 18 L12 14.5 L7 18 L9 12 L4 8 L10 8 Z"/>
              </svg>
            </span>
            <input
              ref={inputRef}
              type="text"
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              disabled={!isInputPhase || botTyping}
              placeholder={listening ? 'Listening… speak now' : isInputPhase ? 'Describe your symptom…' : 'Use the options above'}
              className="w-full bg-[#F3F1FA] rounded-full pl-11 pr-4 py-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#371A82]/30 disabled:opacity-40 transition-all"
            />
          </div>
          <button
            type="button"
            onClick={toggleMic}
            disabled={!isInputPhase || botTyping || !voiceInputSupported}
            aria-label={listening ? 'Stop listening' : 'Speak your symptoms'}
            title={voiceInputSupported ? (listening ? 'Stop listening' : 'Speak your symptoms') : "Voice input isn't supported in this browser"}
            className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 transition-all disabled:opacity-30 ${listening ? 'bg-[#B3261E] text-white animate-pulse' : 'bg-[#EEE9FD] text-[#371A82] hover:bg-[#E2DAFB]'}`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>
            </svg>
          </button>
          <button
            type="submit"
            disabled={!inputText.trim() || !isInputPhase || botTyping}
            className="w-11 h-11 rounded-full bg-gradient-to-br from-[#371A82] to-[#6B48C7] flex items-center justify-center shrink-0 disabled:opacity-30 hover:opacity-90 active:scale-95 transition-all"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </form>
        </div>
      )}
    </div>
  );
}

// ─── Reasoning Screen ─────────────────────────────────────────────────────────

function ReasoningScreen({ session, user, onYes, onNotYet, onBack }: {
  session: SessionData; user: User; onYes: () => void; onNotYet: () => void; onBack: () => void;
}) {
  const cat = session.category;
  if (!cat) return null;

  return (
    <div className="flex-1 flex flex-col bg-[#F3F1FA] overflow-y-auto">
      <div className="bg-[#371A82]">
        <div className="flex items-center gap-2 px-3 pt-1">
          <BackButton onBack={onBack} light />
        </div>
        <div className="px-5 pb-5 pt-1">
          <p className="text-white/60 text-xs font-medium uppercase tracking-wider mb-1">{cat.id === GENERAL_CATEGORY_ID ? 'Summary of your conversation' : 'NG12 Assessment'}</p>
          <h2 style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-white text-xl font-semibold leading-tight">
            {cat.label}
          </h2>
          <p className="text-white/60 text-xs mt-1">{cat.pathway}</p>
        </div>
      </div>

      <div className="px-5 py-5 flex flex-col gap-4">
        <div className="bg-white rounded-2xl overflow-hidden shadow-sm">
          <div className="flex items-center gap-2.5 bg-[#8058DF]/8 px-4 py-3">
            <div className="w-7 h-7 rounded-full bg-[#8058DF]/15 flex items-center justify-center shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#371A82" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.5.4.8 1 .8 1.7v.6h6.4v-.6c0-.7.3-1.3.8-1.7A7 7 0 0 0 12 2z"/>
              </svg>
            </div>
            <p className="text-xs font-semibold text-[#371A82] uppercase tracking-wide">{cat.id === GENERAL_CATEGORY_ID ? 'What we understood' : 'Why this matches NG12'}</p>
          </div>
          <div className="p-4">
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{cat.reasoning}</p>
            <div className="mt-3 pl-3 border-l-2 border-[#8058DF]/40 flex gap-2 items-start">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8058DF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide font-semibold mb-1">{cat.id === GENERAL_CATEGORY_ID ? 'NG12 status' : 'Criterion matched'}</p>
                <p className="text-xs text-[#371A82] font-medium">{cat.ng12Criterion}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl overflow-hidden shadow-sm">
          <div className="flex items-center gap-2.5 bg-green-50 px-4 py-3">
            <div className="w-7 h-7 rounded-full bg-green-100 flex items-center justify-center shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#15803d" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </div>
            <p className="text-xs font-semibold text-[#371A82] uppercase tracking-wide">What this could mean</p>
          </div>
          <div className="p-4 flex flex-col gap-2">
            {cat.possibilities.map((p, i) => (
              <div key={i} className="flex gap-2.5 items-start">
                <span className={`w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center shrink-0 mt-0.5 ${i === 0 ? 'bg-green-100 text-green-700' : i === 1 ? 'bg-[#8058DF]/15 text-[#8058DF]' : 'bg-[#371A82]/10 text-[#371A82]'}`}>
                  {i + 1}
                </span>
                <p className="text-xs text-gray-700 leading-relaxed">{p}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[#8058DF]/10 border border-[#8058DF]/25 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-[#8058DF]" />
            <p className="text-xs font-semibold text-[#4A3080] uppercase tracking-wide">Reassurance</p>
          </div>
          <p className="text-sm text-[#3D2570] leading-relaxed">{cat.reassuranceStat}</p>
          <p className="text-xs text-[#4A3080] mt-2 font-medium">Likely pathway: <span className="text-[#371A82]">{cat.referralType === '2WW' ? '2-Week Wait (2WW) referral' : cat.referralType}</span></p>
        </div>

        <div className="bg-white rounded-2xl p-5 shadow-sm">
          <p style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-[#371A82] text-base font-semibold text-center leading-snug mb-1">
            Should I submit a summary of this to your GP?
          </p>
          <p className="text-xs text-gray-400 text-center mb-5 leading-relaxed">
            This will send a note to <strong className="text-gray-600">{user.gpPractice}</strong> on your behalf. Nothing has been sent yet.
          </p>
          {!user.consent && (
            <p role="alert" className="text-xs text-[#B3261E] text-center mb-4 leading-relaxed">
              You've turned off sharing with your GP. Turn it back on in Settings (menu, then Settings) to submit this summary.
            </p>
          )}
          <div className="flex gap-3">
            <button onClick={onNotYet} className="flex-1 border-2 border-gray-200 text-gray-600 py-3 rounded-xl font-semibold text-sm hover:border-gray-300 active:scale-95 transition-all">
              Not yet
            </button>
            <button onClick={onYes} disabled={!user.consent} className="flex-1 bg-[#371A82] text-white py-3 rounded-xl font-semibold text-sm hover:bg-[#2A1560] active:scale-95 transition-all disabled:opacity-40 disabled:active:scale-100">
              Yes, submit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Submitting Screen ────────────────────────────────────────────────────────

function SubmittingScreen({
  user,
  session,
  onDone,
}: {
  user: User;
  session: SessionData;
  onDone: () => void;
}) {
  const [submitted, setSubmitted] = useState(false);
  const cat = session.category;

  useEffect(() => {
    const timer = setTimeout(() => {
      setSubmitted(true);
    }, 1800);

    return () => clearTimeout(timer);
  }, []);

  // ─────────────────────────────────────────────
  // SUCCESS STATE
  // ─────────────────────────────────────────────

  if (submitted) {
    return (
      <div className="flex-1 flex flex-col bg-[#F3F1FA]">
        <div className="flex-1 flex items-end">
          <div
            className="
              w-full
              bg-white
              rounded-t-[28px]
              px-5
              pt-5
              pb-6
              shadow-[0_-10px_35px_rgba(0,0,0,0.12)]
              animate-[slideUp_.3s_ease-out]
            "
          >
            {/* Drag handle */}
            <div className="w-10 h-1 rounded-full bg-[#E4E4EA] mx-auto mb-6" />

            {/* Success icon */}
            <div className="flex justify-center mb-5">
              <div className="w-[58px] h-[58px] rounded-full bg-[#F0EDF9] flex items-center justify-center">
                <svg
                  width="29"
                  height="29"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#371A82"
                  strokeWidth="2.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
            </div>

            {/* Success message */}
            <div className="text-center mb-5">
              <h2
                style={{
                  fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif",
                }}
                className="text-[#371A82] text-[19px] leading-[1.25] font-semibold px-2"
              >
                Pre-consultation summary
                <br />
                submitted to your GP
              </h2>

              <div className="inline-flex items-center justify-center mt-3 px-4 py-1.5 rounded-full bg-[#F0EDF9]">
                <p className="text-[#8058DF] text-xs font-medium">
                  Sent to {user.gpPractice}
                </p>
              </div>
            </div>

            {/* GP notification */}
            <div className="bg-[#F3F1FA] rounded-xl px-3.5 py-3.5 mb-5">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-full bg-[#E9E4FA] flex items-center justify-center shrink-0">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#8058DF"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="7" r="4" />
                    <path d="M5.5 21c.7-4 3-6 6.5-6s5.8 2 6.5 6" />
                    <path d="M8 17.5h8" />
                  </svg>
                </div>

                <p className="text-[12px] text-[#667085] leading-[1.6]">
                  Your GP has received a note about your symptom:{' '}
                  <strong className="text-[#371A82] font-semibold">
                    {cat?.label || 'your symptoms'}
                  </strong>
                  . They will be in touch to arrange next steps, usually within
                  48 hours.
                </p>
              </div>
            </div>

            {/* Continue */}
            <button
              onClick={onDone}
              className="
                w-full
                bg-[#371A82]
                hover:bg-[#2A1560]
                text-white
                py-4
                rounded-xl
                font-semibold
                text-sm
                transition-all
                active:scale-[0.98]
                shadow-sm
              "
            >
              Continue
            </button>
          </div>
        </div>

        <style>{`
          @keyframes slideUp {
            from {
              transform: translateY(35px);
              opacity: 0;
            }
            to {
              transform: translateY(0);
              opacity: 1;
            }
          }
        `}</style>
      </div>
    );
  }

  // ─────────────────────────────────────────────
  // LOADING STATE
  // ─────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col bg-[#F3F1FA]">
      <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
        <div className="relative w-[62px] h-[62px] mb-6">
          <div className="absolute inset-0 rounded-full border-[3px] border-[#8058DF]/20" />
          <div className="absolute inset-0 rounded-full border-[3px] border-transparent border-t-[#371A82] animate-spin" />
        </div>

        <h2
          style={{
            fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif",
          }}
          className="text-[#371A82] text-[20px] font-semibold"
        >
          Sending your summary...
        </h2>

        <p className="text-[#98A2B3] text-sm mt-2">
          Submitting a note to {user.gpPractice}
        </p>
      </div>
    </div>
  );
}

// ─── Not Submitted Screen ─────────────────────────────────────────────────────


function NotSubmittedScreen({ onReconsider, onHome }: { onReconsider: () => void; onHome: () => void }) {
  return (
    <div className="flex-1 flex flex-col bg-[#F3F1FA] overflow-y-auto">
      <div className="bg-[#371A82]">
        <div className="px-5 pb-5">
          <h2 style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-white text-xl font-semibold">Nothing sent</h2>
        </div>
      </div>

      <div className="px-5 py-6 flex flex-col gap-4">
        <div className="bg-white rounded-2xl p-5 shadow-sm text-center">
          <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-3">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>
            </svg>
          </div>
          <p style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-gray-700 text-base font-semibold mb-2">No information has been shared</p>
          <p className="text-gray-400 text-sm leading-relaxed">
            Your symptom description stays private. Nothing has been sent to your GP or any other service.
          </p>
        </div>

        <div className="bg-[#8058DF]/10 border border-[#8058DF]/20 rounded-2xl p-4">
          <p className="text-[#4A3080] text-sm leading-relaxed">
            You can reconsider and send the summary at any time, or speak to your GP directly if your symptoms change or worsen.
          </p>
        </div>

        <button onClick={onReconsider} className="w-full bg-[#371A82] text-white py-4 rounded-xl font-semibold text-sm hover:bg-[#2A1560] active:scale-95 transition-all">
          I've reconsidered — submit to my GP
        </button>
        <button onClick={onHome} className="w-full border border-gray-200 text-gray-500 py-3.5 rounded-xl font-medium text-sm hover:bg-white active:scale-95 transition-all">
          Return to home
        </button>
      </div>
    </div>
  );
}

// ─── Review Screen ────────────────────────────────────────────────────────────

function ReviewScreen({
  session,
  user,
  onContinue,
}: {
  session: SessionData;
  user: User;
  onContinue: () => void;
}) {
  const cat = session.category;

  return (
    <div className="flex-1 flex flex-col bg-[#F3F1FA] overflow-y-auto">

      {/* ───────────── Purple Assessment Header ───────────── */}
      <div className="bg-[#371A82] text-white">
        <div className="px-5 pt-5 pb-6">

          <p className="text-white/60 text-[11px] font-medium uppercase tracking-[0.12em] mb-2">
            NG12 ASSESSMENT
          </p>

          <h1
            style={{
              fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif",
            }}
            className="text-white text-[21px] leading-tight font-semibold"
          >
            {cat?.label || "Symptom assessment"}
          </h1>

          <p className="text-white/60 text-xs mt-1.5 leading-relaxed">
            {cat?.pathway ||
              "Your symptoms have been reviewed against NHS NG12 guidance"}
          </p>
        </div>
      </div>

      {/* ───────────── Content ───────────── */}
      <div className="px-5 py-5 flex flex-col gap-4">

        {/* ───────────── Why this matches NG12 ───────────── */}
        {cat && (
          <div className="bg-white rounded-2xl overflow-hidden shadow-sm">

            <div className="flex items-center gap-2.5 bg-[#8058DF]/8 px-4 py-3">

              <div className="w-7 h-7 rounded-full bg-[#8058DF]/15 flex items-center justify-center shrink-0">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#371A82"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 18h6" />
                  <path d="M10 22h4" />
                  <path d="M12 2a7 7 0 0 0-4 12.7c.5.4.8 1 .8 1.7v.6h6.4v-.6c0-.7.3-1.3.8-1.7A7 7 0 0 0 12 2z" />
                </svg>
              </div>

              <p className="text-xs font-semibold text-[#371A82] uppercase tracking-wide">
                Why this matches NG12
              </p>
            </div>

            <div className="p-4">

              <p className="text-sm text-[#344054] leading-[1.65]">
                {cat.reasoning}
              </p>

              <div className="mt-4 pl-3 border-l-2 border-[#8058DF]/40 flex gap-2 items-start">

                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#8058DF"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0 mt-0.5"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>

                <div>
                  <p className="text-[10px] text-gray-400 uppercase tracking-wide font-semibold mb-1">
                    Criterion matched
                  </p>

                  <p className="text-xs text-[#371A82] font-medium leading-relaxed">
                    {cat.ng12Criterion}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ───────────── What this could mean ───────────── */}
        {cat && (
          <div className="bg-white rounded-2xl overflow-hidden shadow-sm">

            <div className="flex items-center gap-2.5 bg-green-50 px-4 py-3">

              <div className="w-7 h-7 rounded-full bg-green-100 flex items-center justify-center shrink-0">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#15803d"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </div>

              <p className="text-xs font-semibold text-[#371A82] uppercase tracking-wide">
                What this could mean
              </p>
            </div>

            <div className="p-4 flex flex-col gap-2.5">

              {cat.possibilities.map((possibility, index) => (
                <div
                  key={index}
                  className="flex gap-2.5 items-start"
                >

                  <span
                    className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold ${
                      index === 2
                        ? "bg-[#8058DF]/15 text-[#371A82]"
                        : "bg-green-100 text-green-700"
                    }`}
                  >
                    {index + 1}
                  </span>

                  <p className="text-xs text-[#475467] leading-[1.55] pt-0.5">
                    {possibility}
                  </p>

                </div>
              ))}

            </div>
          </div>
        )}

        {/* ───────────── Reassurance ───────────── */}
        {cat && (
          <div className="bg-[#8058DF]/10 border border-[#8058DF]/20 rounded-2xl overflow-hidden">

            <div className="flex items-center gap-2.5 px-4 pt-3.5">

              <div className="w-7 h-7 rounded-full bg-[#8058DF]/15 flex items-center justify-center">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#371A82"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" />
                  <path d="M12 8v4" />
                  <path d="M12 16h.01" />
                </svg>
              </div>

              <p className="text-xs font-semibold text-[#371A82] uppercase tracking-wide">
                Reassurance
              </p>
            </div>

            <div className="px-4 pb-4 pt-2">

              <p className="text-sm text-[#3D2570] leading-relaxed font-medium">
                {cat.reassuranceStat}
              </p>

              <p className="text-xs text-[#5B4A7A] leading-relaxed mt-2">
                Being referred for further assessment does not mean you have
                cancer. The referral is a precautionary step to make sure the
                cause of your symptoms is properly investigated.
              </p>

            </div>
          </div>
        )}

        {/* ───────────── Symptom reported ───────────── */}
        <div className="bg-white rounded-2xl p-4 shadow-sm">

          <p className="text-xs font-semibold text-[#371A82] uppercase tracking-wide mb-2">
            What you told us
          </p>

          <div className="bg-[#F3F1FA] rounded-xl px-3.5 py-3">
            <p className="text-sm text-[#344054] italic leading-relaxed">
              "{session.userInput}"
            </p>
          </div>

        </div>

        {/* ───────────── Continue ───────────── */}
        <button
          onClick={onContinue}
          className="w-full bg-[#371A82] text-white py-4 rounded-xl font-semibold text-sm hover:bg-[#2A1560] active:scale-[0.98] transition-all shadow-sm"
        >
          View your next steps
        </button>

        <p className="text-[10px] text-gray-400 text-center leading-relaxed px-3 pb-3">
          This assessment is based on NHS NG12 guidance and is not a diagnosis.
          Your healthcare professional will make the final clinical assessment.
        </p>

      </div>
    </div>
  );
}

// ─── Next Steps Screen ────────────────────────────────────────────────────────


// ─── Trusted links ────────────────────────────────────────────────────────────
// Only addresses that were checked and return real, relevant pages (verified 2026-09-21). The workbook's rule
// stands: never add a link without opening it first. The first four Cancer Research UK entries come straight from
// the workbook's "Symptom Resource Links" tab.
interface ResourceLink { label: string; url: string; blurb: string; source: string }
const CRUK = 'https://cruk.org/spotcancerearly';
const nhs = (label: string, slug: string, blurb: string): ResourceLink => ({ label, url: `https://www.nhs.uk/conditions/${slug}/`, blurb, source: 'NHS' });

const CANCER_LINKS: { match: RegExp; links: ResourceLink[] }[] = [
  { match: /colorectal|bowel|lower gi|rectal|anal\b/i, links: [
    { label: 'Spot bowel cancer early', url: CRUK, blurb: 'Symptoms to look out for and what to expect.', source: 'Cancer Research UK' },
    nhs('Bowel cancer', 'bowel-cancer', 'Symptoms, tests and what happens next.')] },
  { match: /lung|mesothelioma|pleural|\bcxr\b/i, links: [
    { label: 'Spot lung cancer early', url: CRUK, blurb: 'Symptoms to look out for and what to expect.', source: 'Cancer Research UK' },
    nhs('Lung cancer', 'lung-cancer', 'Symptoms, tests and what happens next.')] },
  { match: /breast/i, links: [
    { label: 'Spot breast cancer early', url: CRUK, blurb: 'Symptoms to look out for and what to expect.', source: 'Cancer Research UK' },
    nhs('Breast cancer in women', 'breast-cancer-in-women', 'Symptoms, tests and what happens next.')] },
  { match: /cervi/i, links: [
    { label: 'Spot cervical cancer early', url: CRUK, blurb: 'Symptoms to look out for and what to expect.', source: 'Cancer Research UK' },
    nhs('Cervical cancer', 'cervical-cancer', 'Symptoms, screening and treatment.')] },
  { match: /ovar|gynae/i, links: [nhs('Ovarian cancer', 'ovarian-cancer', 'Symptoms, tests and what happens next.')] },
  { match: /endometri|womb|uterine|post-?menopausal/i, links: [nhs('Womb (uterus) cancer', 'womb-cancer', 'Symptoms, tests and what happens next.')] },
  { match: /bladder|urinary|haematuria|urolog/i, links: [nhs('Bladder cancer', 'bladder-cancer', 'Symptoms, tests and what happens next.')] },
  { match: /prostate/i, links: [nhs('Prostate cancer', 'prostate-cancer', 'Symptoms, tests and what happens next.')] },
  { match: /testic/i, links: [nhs('Testicular cancer', 'testicular-cancer', 'Symptoms, tests and what happens next.')] },
  { match: /kidney|renal/i, links: [nhs('Kidney cancer', 'kidney-cancer', 'Symptoms, tests and what happens next.')] },
  { match: /melanoma|skin|basal|squamous/i, links: [nhs('Melanoma skin cancer', 'melanoma-skin-cancer', 'Signs to look for and what happens next.')] },
  { match: /laryn|hoarse|voice|head and neck|head \+ neck|thyroid/i, links: [nhs('Laryngeal cancer', 'laryngeal-cancer', 'Symptoms, tests and what happens next.')] },
  { match: /oral|mouth|tongue/i, links: [nhs('Mouth cancer', 'mouth-cancer', 'Symptoms, tests and what happens next.')] },
  { match: /oesophag|dysphagia|swallow/i, links: [nhs('Oesophageal cancer', 'oesophageal-cancer', 'Symptoms, tests and what happens next.')] },
  { match: /stomach|gastric|upper gi/i, links: [nhs('Stomach cancer', 'stomach-cancer', 'Symptoms, tests and what happens next.')] },
  { match: /pancrea|liver|biliary|jaundice/i, links: [nhs('Pancreatic cancer', 'pancreatic-cancer', 'Symptoms, tests and what happens next.')] },
  { match: /lymphoma/i, links: [nhs('Non-Hodgkin lymphoma', 'non-hodgkin-lymphoma', 'Symptoms, tests and what happens next.')] },
  { match: /myeloma/i, links: [nhs('Myeloma', 'myeloma', 'Symptoms, tests and what happens next.')] },
  { match: /leuk|haematolog/i, links: [nhs('Acute myeloid leukaemia', 'acute-myeloid-leukaemia', 'Symptoms, tests and what happens next.')] },
  { match: /sarcoma|bone/i, links: [nhs('Bone cancer', 'bone-cancer', 'Symptoms, tests and what happens next.')] },
];
const CATEGORY_CANCER: Record<string, string> = {
  haemoptysis: 'lung', rectalBleeding: 'bowel', breast: 'breast', haematuria: 'bladder',
  skin: 'melanoma skin', dysphagia: 'oesophageal', pmb: 'womb',
};
const GENERAL_CANCER_LINKS: ResourceLink[] = [
  { label: 'Suspected cancer: recognition and referral (NICE NG12)', url: 'https://www.nice.org.uk/guidance/ng12', blurb: 'The guidance your GP follows.', source: 'NICE' },
  { label: 'Macmillan Cancer Support', url: 'https://www.macmillan.org.uk/', blurb: 'Free support and information, whatever the outcome.', source: 'Macmillan' },
];

/** Links for the cancer types this conversation points to. Empty when nothing suggests cancer. */
function linksFor(texts: string[]): ResourceLink[] {
  const found: ResourceLink[] = [];
  for (const t of texts) {
    if (!t) continue;
    for (const entry of CANCER_LINKS) {
      if (entry.match.test(t)) for (const l of entry.links) if (!found.some(f => f.url === l.url && f.label === l.label)) found.push(l);
    }
  }
  if (!found.length) return [];
  // Cancer Research UK's hub is one page: show it once.
  const seenUrls = new Set<string>();
  const unique = found.filter(l => (seenUrls.has(l.url) ? false : (seenUrls.add(l.url), true)));
  return [...unique.slice(0, 4), ...GENERAL_CANCER_LINKS];
}

function ResourceLinks({ links }: { links: ResourceLink[] }) {
  if (!links.length) return null;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="px-1 pt-1">
        <p className="text-[11px] font-bold text-[#371A82] uppercase tracking-[0.08em]">READ MORE</p>
        <p className="text-[12px] text-[#71809A] mt-1 leading-[1.5]">Trusted information about what your GP may be looking into. These open in a new tab.</p>
      </div>
      {links.map(l => (
        <a
          key={l.label + l.url} href={l.url} target="_blank" rel="noopener noreferrer"
          className="bg-white border border-[#E6E2F0] rounded-2xl p-3.5 shadow-sm flex items-center gap-3 w-full text-left hover:shadow-md transition-all"
        >
          <div className="w-9 h-9 rounded-lg bg-[#EEE9FD] flex items-center justify-center shrink-0">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#371A82" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] text-[#371A82] font-semibold leading-snug">{l.label}</p>
            <p className="text-[11px] text-[#71809A] leading-snug mt-0.5">{l.source} · {l.blurb}</p>
          </div>
        </a>
      ))}
    </div>
  );
}

// Personalised appointment preparation: what the GP is likely to suggest for THIS patient's symptoms,
// and exactly how to prepare. The wording comes from the NHS Preparation Support sheet, not from the model.
function PersonalisedPrep({ items, symptoms }: { items: PrepItem[]; symptoms: string }) {
  const sections: Array<[string, keyof PrepItem]> = [
    ['Before your appointment', 'before'],
    ['On the day', 'day_of'],
    ['What to bring', 'bring'],
    ['Afterwards', 'after'],
  ];
  const meaningful = (v: string) => v && !/^(n\/a\.?|none\.?)$/i.test(v.trim());
  return (
    <>
      <div className="bg-white border border-[#E6E2F0] rounded-2xl p-4 shadow-sm">
        <p className="text-[11px] font-bold text-[#371A82] uppercase tracking-[0.08em] mb-1.5">WHAT TO TELL YOUR GP</p>
        <p className="text-[13px] text-[#526078] leading-[1.55] italic">{'\u201c'}{symptoms}{'\u201d'}</p>
        <p className="text-[12px] text-[#71809A] mt-2 leading-[1.5]">Keep a note of when it started, how often it happens, and anything that makes it better or worse.</p>
      </div>
      <div className="px-1 pt-1">
        <p className="text-[11px] font-bold text-[#371A82] uppercase tracking-[0.08em]">WHAT YOUR GP MAY SUGGEST</p>
        <p className="text-[12px] text-[#71809A] mt-1 leading-[1.5]">Based on what you told us and NICE NG12 guidance. Your GP will decide what is right for you.</p>
      </div>
      {items.map((it, i) => (
        <div key={it.test + i} className="bg-white border border-[#E6E2F0] rounded-2xl p-4 shadow-sm">
          <div className="flex items-start justify-between gap-2">
            <h3 style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-[#371A82] text-[17px] font-semibold leading-tight">{it.test}</h3>
            {it.category && <span className="shrink-0 text-[10px] font-semibold text-[#4A3080] bg-[#EEE9FD] rounded-full px-2 py-0.5">{it.category}</span>}
          </div>
          <p className="text-[12px] text-[#64748B] leading-[1.55] mt-2">{it.why}</p>
          <div className="mt-3 flex flex-col gap-2.5">
            {sections.filter(([, k]) => meaningful(it[k])).map(([label, k]) => (
              <div key={k} className="pl-3 border-l-2 border-[#8058DF]/40">
                <p className="text-[10px] text-gray-400 uppercase tracking-wide font-semibold mb-0.5">{label}</p>
                <p className="text-[13px] text-[#3D2570] leading-[1.55]">{it[k]}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function NextStepsScreen({
  session,
  user,
  onHome,
}: {
  session: SessionData;
  user: User | null;
  onHome: () => void;
}) {
  const cat = session.category;
  // undefined = still loading, null = unavailable (falls back to the generic list below)
  const [prep, setPrep] = useState<PrepItem[] | null | undefined>(undefined);
  const resourceLinks = linksFor([cat ? CATEGORY_CANCER[cat.id] ?? '' : '', ...(prep ?? []).map(it => `${it.cancer} ${it.test}`)]);
  useEffect(() => {
    let live = true;
    const symptoms = session.userInput || cat?.label || '';
    getPreparation(user?.nhsNumber ?? '', symptoms).then(r => { if (live) setPrep(r && r.items.length ? r.items : null); });
    return () => { live = false; };
  }, []);

  return (
    <div className="flex-1 flex flex-col bg-[#F5F3FB] overflow-hidden relative">

      {/* ─────────────────────────────────────────────
          HEADER
      ───────────────────────────────────────────── */}
      <div className="bg-[#371A82] px-5 pt-4 pb-5 shrink-0">
        <p className="text-white/65 text-[11px] font-semibold uppercase tracking-[0.16em] mb-1.5">
          NEXT STEPS
        </p>

        <h2
          style={{
            fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif",
          }}
          className="text-white text-[21px] font-semibold leading-tight"
        >
          Appointment preparation
        </h2>
      </div>


      {/* ─────────────────────────────────────────────
          SCROLLABLE CONTENT
      ───────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-4">

        <div className="flex flex-col gap-3.5">

          {/* GP REFERRAL SECTION */}
          <div className="bg-[#F0EDFC] border border-[#DDD5F8] rounded-2xl p-4 shadow-sm">

            <div className="flex items-start gap-3">

              <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center shrink-0">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#371A82"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="4" width="18" height="17" rx="2" />
                  <path d="M8 2v4M16 2v4M3 10h18" />
                </svg>
              </div>

              <div className="flex-1">

                <p className="text-[11px] font-bold text-[#371A82] uppercase tracking-[0.08em] mb-1.5">
                  WHAT TO EXPECT
                </p>

                <h3
                  style={{
                    fontFamily:
                      "'Baloo 2', 'Inter', system-ui, sans-serif",
                  }}
                  className="text-[#371A82] text-[17px] font-semibold leading-tight mb-1.5"
                >
                  Your GP might refer you
                </h3>

                <p className="text-[13px] text-[#526078] leading-[1.55]">
                  After your appointment, your GP may refer you to a
                  specialist for further investigation or treatment,
                  depending on your symptoms and examination.
                </p>

              </div>
            </div>

          </div>


          {prep === undefined && (
            <div className="bg-white border border-[#E6E2F0] rounded-2xl p-4 shadow-sm">
              <p className="text-[13px] text-[#71809A]">Preparing guidance for your symptoms…</p>
            </div>
          )}
          {prep && prep.length > 0 && <PersonalisedPrep items={prep} symptoms={session.userInput} />}
          {prep === null && (
          <>
          {/* TESTS SECTION */}
          <div className="bg-white border border-[#E6E2F0] rounded-2xl p-4 shadow-sm">

            <div className="flex items-start gap-3 mb-4">

              <div className="w-10 h-10 rounded-full bg-[#EEE9FD] flex items-center justify-center shrink-0">
                <svg
                  width="21"
                  height="21"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#371A82"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 2v7" />
                  <path d="M9 9h6" />
                  <path d="M7 9v7a5 5 0 0 0 10 0V9" />
                  <path d="M9 20h6" />
                </svg>
              </div>

              <div className="flex-1">

                <p className="text-[11px] font-bold text-[#371A82] uppercase tracking-[0.08em] mb-1.5">
                  TESTS ABOUT THE GP MIGHT REFER
                </p>

                <h3
                  style={{
                    fontFamily:
                      "'Baloo 2', 'Inter', system-ui, sans-serif",
                  }}
                  className="text-[#371A82] text-[17px] font-semibold leading-tight"
                >
                  What to expect
                </h3>

                <p className="text-[13px] text-[#71809A] mt-1">
                  Probable diagnostic tests
                </p>

              </div>
            </div>
          {/* Blood tests */}
            <div className="flex gap-3 py-2.5">

              <div className="w-9 h-9 rounded-full bg-[#F0EDFC] flex items-center justify-center shrink-0">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#371A82"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 2s6 7 6 12a6 6 0 0 1-12 0c0-5 6-12 6-12Z" />
                </svg>
              </div>

              <div>
                <p className="text-[14px] font-semibold text-[#371A82]">
                  Blood tests
                </p>
                <p className="text-[12px] text-[#64748B] leading-[1.5] mt-0.5">
                  To check for markers or other indicators related to
                  your symptoms.
                </p>
              </div>

            </div>


            <div className="h-px bg-[#EEEAF6] ml-12" />


            {/* Imaging */}
            <div className="flex gap-3 py-3">

              <div className="w-9 h-9 rounded-full bg-[#F0EDFC] flex items-center justify-center shrink-0">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#371A82"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <circle cx="12" cy="12" r="3" />
                  <path d="M7 8h2" />
                </svg>
              </div>

              <div>
                <p className="text-[14px] font-semibold text-[#371A82]">
                  Imaging (if needed)
                </p>
                <p className="text-[12px] text-[#64748B] leading-[1.5] mt-0.5">
                  Such as an ultrasound, CT or MRI scan to get a clearer
                  view of the affected area.
                </p>
              </div>

            </div>


            <div className="h-px bg-[#EEEAF6] ml-12" />


            {/* Biopsy */}
            <div className="flex gap-3 pt-3">

              <div className="w-9 h-9 rounded-full bg-[#F0EDFC] flex items-center justify-center shrink-0">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#371A82"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="5" y="3" width="14" height="18" rx="2" />
                  <path d="M9 7h6M9 11h6M9 15h4" />
                </svg>
              </div>

              <div>
                <p className="text-[14px] font-semibold text-[#371A82]">
                  Biopsy (if needed)
                </p>
                <p className="text-[12px] text-[#64748B] leading-[1.5] mt-0.5">
                  A small tissue sample may be taken for further analysis,
                  if required.
                </p>
              </div>

            </div>

          </div>


          </>
          )}

          {/* PATHWAY / REASSURANCE */}
          <div className="bg-[#EDE8FB] border border-[#D8CDF7] rounded-2xl p-4">

            <p className="text-[13px] text-[#3D2570] leading-[1.55] font-medium">
              {cat?.reassuranceStat ||
                "A referral means your GP is being cautious — it is not a diagnosis."}
            </p>

            <p className="text-[11px] text-[#58468A] mt-2 leading-[1.5]">
              Your GP will explain which investigations are appropriate
              for you and what happens next.
            </p>

          </div>


          {/* OPTIONAL RESOURCE */}
          <ResourceLinks links={resourceLinks} />

        </div>

        {/* Bottom breathing room so content never sits behind the button */}
        <div className="h-3" />

      </div>


      {/* ─────────────────────────────────────────────
          FIXED BOTTOM ACTION
      ───────────────────────────────────────────── */}
      <div className="shrink-0 px-4 pt-3 pb-4 bg-[#F5F3FB] border-t border-[#E5E1EF]">

        <button
          onClick={onHome}
          className="
            w-full
            bg-[#371A82]
            text-white
            py-3.5
            rounded-xl
            font-semibold
            text-sm
            hover:bg-[#2A1560]
            active:scale-[0.98]
            transition-all
            shadow-sm
          "
        >
          Return to home
        </button>

      </div>

    </div>
  );
}

// ─── Safety Net Screen ────────────────────────────────────────────────────────

function SafetyNetScreen({ onHome, session }: { onHome: () => void; session: SessionData }) {
  return (
    <div className="flex-1 flex flex-col bg-[#F3F1FA] overflow-y-auto">
      <div className="bg-[#371A82]">
        <div className="px-5 pb-5">
          <p className="text-white/60 text-xs font-medium uppercase tracking-wider mb-1">Next steps</p>
          <h2 style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-white text-xl font-semibold">Safety netting</h2>
        </div>
      </div>

      <div className="px-5 py-5 flex flex-col gap-4">
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="text-xs font-semibold text-[#371A82] uppercase tracking-wide mb-2">Summary</p>
          <p className="text-sm text-gray-600 leading-relaxed">No specific NICE NG12 criterion was identified from your symptom description. That doesn't mean your symptoms aren't worth investigating — it simply means they don't fit a current referral threshold.</p>
        </div>

        <div className="bg-[#8058DF]/10 border border-[#8058DF]/20 rounded-2xl p-4">
          <p className="text-sm font-semibold text-[#4A3080] mb-1.5">Recommended: speak to your GP</p>
          <p className="text-sm text-[#3D2570] leading-relaxed">If your symptoms persist for more than 2 weeks, worsen, or you develop new symptoms, please speak with your GP practice directly.</p>
        </div>

        <div className="bg-white rounded-2xl p-4 shadow-sm flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[#371A82]/10 flex items-center justify-center shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#371A82" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="12 8 12 12 14 14"/><circle cx="12" cy="12" r="10"/>
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-[#371A82]">Automatic check-in in 14 days</p>
            <p className="text-xs text-gray-400 mt-0.5">You'll receive a prompt to revisit your symptoms on {new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'long' })}</p>
          </div>
        </div>

        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="text-xs font-semibold text-[#371A82] uppercase tracking-wide mb-2">Recheck question</p>
          <p className="text-sm text-gray-600 leading-relaxed">Have you noticed any of the following since your first symptom appeared?</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {['Unexplained weight loss', 'Blood in urine, stool, or phlegm', 'A lump or swelling', 'Persistent fatigue or night sweats'].map(s => (
              <li key={s} className="flex items-center gap-2 text-xs text-gray-600">
                <div className="w-1.5 h-1.5 rounded-full bg-[#8058DF] shrink-0" />{s}
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-400 mt-3 leading-relaxed">If yes, please start a new chat or contact your GP directly.</p>
        </div>

        <button onClick={onHome} className="w-full bg-[#371A82] text-white py-4 rounded-xl font-semibold text-sm hover:bg-[#2A1560] active:scale-95 transition-all">
          Return to home
        </button>
      </div>
    </div>
  );
}

// ─── Emergency Screen ─────────────────────────────────────────────────────────

function EmergencyScreen({ onHome }: { onHome: () => void }) {
  return (
    <div className="flex-1 flex flex-col bg-[#B3261E] overflow-y-auto">
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center py-8">
        <div className="w-20 h-20 rounded-full bg-white/20 flex items-center justify-center mb-6">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>
        <h1 style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-white text-2xl font-bold mb-3 leading-tight">
          Call 999 or go to A&amp;E now
        </h1>
        <p className="text-white/80 text-sm leading-relaxed mb-8 max-w-xs">
          Based on what you've described, you may need immediate medical attention. This bypasses the GP summary step — your safety comes first.
        </p>

        <div className="bg-white/15 rounded-2xl p-5 w-full mb-8 text-left">
          <p className="text-white text-xs font-semibold uppercase tracking-wide mb-3">What to do right now</p>
          {['Call 999 immediately', 'Or go to your nearest A&E', 'Do not drive yourself — ask someone or take a taxi', 'Tell them what you told this chatbot'].map((s, i) => (
            <div key={i} className="flex items-start gap-2.5 py-1.5">
              <span className="w-5 h-5 rounded-full bg-white/20 text-white text-[10px] font-bold flex items-center justify-center shrink-0">{i + 1}</span>
              <p className="text-white/90 text-sm">{s}</p>
            </div>
          ))}
        </div>

        <a href="tel:999" className="w-full bg-white text-[#B3261E] py-4 rounded-xl font-bold text-lg flex items-center justify-center gap-2 mb-3 active:scale-95 transition-all">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13.5a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2.69h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 10.4a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
          </svg>
          Call 999
        </a>

        <button onClick={onHome} className="text-white/60 text-sm py-2 underline underline-offset-2">
          Back to home
        </button>
      </div>
    </div>
  );
}

// ─── Chat History Screen ──────────────────────────────────────────────────────

const STATUS_LABELS: Record<HistoryEntry['status'], string> = {
  'submitted': 'Submitted to GP',
  'safety-netting': 'Safety netting',
  'emergency': 'Emergency — 999/A&E',
  'not-submitted': 'Not submitted',
};

const STATUS_COLORS: Record<HistoryEntry['status'], string> = {
  'submitted': 'bg-[#371A82]/10 text-[#371A82]',
  'safety-netting': 'bg-[#8058DF]/15 text-[#4A3080]',
  'emergency': 'bg-[#B3261E]/10 text-[#B3261E]',
  'not-submitted': 'bg-gray-100 text-gray-500',
};

function ChatHistoryScreen({ history, onSelect, onBack }: {
  history: HistoryEntry[]; onSelect: (e: HistoryEntry) => void; onBack: () => void;
}) {
  return (
    <div className="flex-1 flex flex-col bg-[#F3F1FA] overflow-y-auto">
      <div className="bg-[#371A82]">
        <div className="flex items-center gap-3 px-4 pb-5">
          <BackButton onBack={onBack} light />
          <h2 style={{ fontFamily: "'Baloo 2', 'Inter', system-ui, sans-serif" }} className="text-white text-xl font-semibold">Past chats</h2>
        </div>
      </div>

      <div className="px-5 py-5 flex flex-col gap-3">
        {history.length === 0 ? (
          <div className="bg-white rounded-2xl p-8 text-center shadow-sm">
            <p className="text-gray-400 text-sm">No conversations yet.</p>
            <p className="text-gray-300 text-xs mt-1">Start a new chat from the home screen.</p>
          </div>
        ) : (
          history.map(entry => (
            <button
              key={entry.id}
              onClick={() => onSelect(entry)}
              className="w-full bg-white rounded-2xl p-4 shadow-sm flex items-center justify-between hover:shadow-md active:scale-[0.98] transition-all text-left"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-800 truncate">{entry.pathway || STATUS_LABELS[entry.status]}</p>
                <p className="text-xs text-gray-400 mt-0.5">{formatTime(entry.timestamp)}</p>
                <span className={`inline-block mt-2 text-[10px] font-semibold px-2.5 py-1 rounded-full ${STATUS_COLORS[entry.status]}`}>
                  {STATUS_LABELS[entry.status]}
                </span>
              </div>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 ml-3">
                <path d="M9 18l6-6-6-6"/>
              </svg>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Chat Transcript Screen ───────────────────────────────────────────────────

function ChatTranscriptScreen({ entry, onBack }: { entry: HistoryEntry; onBack: () => void }) {
  return (
    <div className="flex-1 flex flex-col bg-[#F3F1FA] overflow-hidden">
      <div className="bg-[#371A82]">
        <div className="flex items-center gap-3 px-4 pb-4">
          <BackButton onBack={onBack} light />
          <div className="flex-1 min-w-0">
            <p className="text-white font-semibold text-sm truncate">{entry.pathway || STATUS_LABELS[entry.status]}</p>
            <p className="text-white/50 text-[10px]">{formatTime(entry.timestamp)}</p>
          </div>
          <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${STATUS_COLORS[entry.status]}`}>
            {STATUS_LABELS[entry.status]}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        <div className="bg-[#8058DF]/10 border border-[#8058DF]/20 rounded-xl p-3 text-center mb-1">
          <p className="text-[10px] text-[#4A3080] font-medium">Read-only transcript</p>
        </div>

        {entry.messages.map(msg => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} gap-2`}>
            {msg.role === 'bot' && (
              <div className="w-6 h-6 rounded-full bg-[#371A82] flex items-center justify-center shrink-0 mt-0.5">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="white"/>
                </svg>
              </div>
            )}
            <div className={`max-w-[78%] px-3.5 py-2.5 rounded-2xl text-xs leading-relaxed whitespace-pre-line ${
              msg.role === 'user' ? 'bg-[#371A82] text-white rounded-tr-sm' : 'bg-white text-gray-700 rounded-tl-sm shadow-sm'
            }`}>
              {msg.text}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [screen, setScreen] = useState<Screen>('splash');
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<SessionData | null>(null);
  const [chatHistory, setChatHistory] = useState<HistoryEntry[]>([]);
  const [selectedHistory, setSelectedHistory] = useState<HistoryEntry | null>(null);
  // Tracks the furthest step reached in the current journey, separately from
  // `screen` (which only reflects where you are RIGHT NOW). Without this, going
  // back to an earlier step would make later steps look unreached again, even
  // though you'd already gotten there — trapping you into redoing the chat to
  // get back to Review/Next steps.
  const [maxStepReached, setMaxStepReached] = useState(0);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const updateSettings = (patch: Partial<Settings>) => {
    setSettings(prev => { const next = { ...prev, ...patch }; saveSettings(next); return next; });
  };

  const go = (s: Screen) => {
    setScreen(s);
    const stepForScreen = STEP_MAP[s];
    if (stepForScreen !== undefined) {
      setMaxStepReached(prev => Math.max(prev, stepForScreen));
    }
  };

  const handleLogin = (u: User) => { setUser(u); setMaxStepReached(0); go('home'); };
  const handleRegister = (u: User) => { setUser(u); setMaxStepReached(0); go('home'); };
  const handleLogout = () => { setUser(null); setSession(null); setMaxStepReached(0); go('welcome'); };

  const handleChatComplete = (s: SessionData) => {
    setSession(s);
    // No category = safety netting (nothing in NG12 matched): Review leads on to the safety-netting plan.
    go(s.category ? 'reasoning' : 'review');
  };

  const handleEmergency = (msgs: ChatMessage[]) => {
    const entry: HistoryEntry = {
      id: genId(), timestamp: new Date(), status: 'emergency',
      messages: msgs,
    };
    setChatHistory(prev => [entry, ...prev]);
    go('emergency');
  };

  const handleYesSubmit = () => {
    go('submitting');
  };

  const handleSubmitDone = () => {
    if (session) {
      const updatedSession = { ...session, submittedToGP: true };
      setSession(updatedSession);
      const entry: HistoryEntry = {
        id: genId(), timestamp: new Date(),
        status: 'submitted',
        pathway: session.category?.pathway,
        messages: session.messages,
      };
      setChatHistory(prev => [entry, ...prev]);
    }

    // After the user taps Continue on the
    // "Pre-consultation summary submitted to your GP"
    // confirmation, go directly to Next Steps.
    go('nextSteps');
  };

  const handleNotYet = () => go('notSubmitted');

  const handleReconsider = () => go('reasoning');

  const handleReviewContinue = () => {
    if (session?.category) go('nextSteps');
    else go('safetyNet');
  };

  const handleHomeFromNext = () => {
    if (session && !session.submittedToGP) {
      const entry: HistoryEntry = {
        id: genId(), timestamp: new Date(),
        status: 'not-submitted',
        messages: session.messages,
      };
      setChatHistory(prev => [entry, ...prev]);
    }
    setSession(null);
    setMaxStepReached(0);
    go('home');
  };

  const handleHomeFromSafetyNet = () => {
    if (session) {
      const entry: HistoryEntry = {
        id: genId(), timestamp: new Date(),
        status: 'safety-netting',
        messages: session.messages,
      };
      setChatHistory(prev => [entry, ...prev]);
    }
    setSession(null);
    setMaxStepReached(0);
    go('home');
  };

  const renderScreen = () => {
    if (!user && !['splash', 'welcome', 'login', 'register'].includes(screen)) go('welcome');

    switch (screen) {
      case 'splash':
        return <SplashScreen onDone={() => go('welcome')} />;
      case 'welcome':
        return <WelcomeScreen onLogin={() => go('login')} onRegister={() => go('register')} />;
      case 'login':
        return <LoginScreen onLogin={handleLogin} onBack={() => go('welcome')} />;
      case 'register':
        return <RegisterScreen onRegister={handleRegister} onBack={() => go('welcome')} />;
      case 'home':
        // "Start a new chat" must always begin fresh: without clearing the session here, a
        // finished conversation is still in state and ChatScreen restores it as initialSession.
        return user ? <HomeScreen user={user} history={chatHistory} onNewChat={() => { setSession(null); setMaxStepReached(0); go('chat'); }} onProfile={() => go('profile')} onHistory={() => go('chatHistory')} onSettings={() => go('settings')} onLogout={handleLogout} /> : null;
      case 'settings':
        return user ? (
          <SettingsScreen
            settings={settings} user={user} onChange={updateSettings}
            onConsentChange={v => setUser(u => (u ? { ...u, consent: v } : u))}
            onReset={() => updateSettings(DEFAULT_SETTINGS)}
            onClearHistory={() => setChatHistory([])} historyCount={chatHistory.length}
            onBack={() => go('home')}
          />
        ) : null;
      case 'profile':
        return user ? <ProfileScreen user={user} history={chatHistory} onBack={() => go('home')} onHistory={() => go('chatHistory')} onLogout={handleLogout} /> : null;
      case 'chat':
        return user ? (
          <ChatScreen
            user={user}
            settings={settings}
            onEmergency={handleEmergency}
            onComplete={handleChatComplete}
            onBack={() => go('home')}
            initialSession={session}
            onContinue={() => go(session?.submittedToGP ? 'review' : 'reasoning')}
          />
        ) : null;
      case 'reasoning':
        return (session && user) ? <ReasoningScreen session={session} user={user} onYes={handleYesSubmit} onNotYet={handleNotYet} onBack={() => go('chat')} /> : null;
      case 'submitting':
        return (session && user) ? <SubmittingScreen user={user} session={session} onDone={handleSubmitDone} /> : null;
      case 'notSubmitted':
        return <NotSubmittedScreen onReconsider={handleReconsider} onHome={() => { setSession(null); setMaxStepReached(0); go('home'); }} />;
      case 'review':
        return (session && user) ? <ReviewScreen session={session} user={user} onContinue={handleReviewContinue} /> : null;
      case 'nextSteps':
        return session ? <NextStepsScreen session={session} user={user} onHome={handleHomeFromNext} /> : null;
      case 'safetyNet':
        return session ? <SafetyNetScreen session={session} onHome={handleHomeFromSafetyNet} /> : null;
      case 'emergency':
        return <EmergencyScreen onHome={() => go('home')} />;
      case 'chatHistory':
        return (
          <ChatHistoryScreen
            history={chatHistory}
            onSelect={e => { setSelectedHistory(e); go('chatTranscript'); }}
            onBack={() => go(screen === 'chatHistory' ? 'home' : 'profile')}
          />
        );
      case 'chatTranscript':
        return selectedHistory ? <ChatTranscriptScreen entry={selectedHistory} onBack={() => go('chatHistory')} /> : null;
      default:
        return null;
    }
  };

  const showStep = STEP_MAP[screen] !== undefined;

  // Steps are clickable in EITHER direction, as long as you've reached them
  // before in this journey (tracked by maxStepReached) — that's what lets you
  // step back to Symptoms and then forward again to Review/Next steps, instead
  // of only ever being able to go backward.
  const handleStepNav = (stepIndex: number) => {
    if (stepIndex === 0) { go('chat'); return; }
    if (stepIndex === 1) {
      go(session?.submittedToGP ? 'review' : 'notSubmitted');
      return;
    }
    if (stepIndex === 2) {
      go(session?.category ? 'nextSteps' : 'safetyNet');
      return;
    }
  };

  return (
    <div
      className={`w-full h-full overflow-hidden bg-[#F3F1FA] flex flex-col ${settings.highContrast ? 'hc' : ''}`}
      style={{ zoom: TEXT_ZOOM[settings.textSize] }}
    >
      <style>{"@import url('https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&display=swap');"}</style>
      {showStep && (screen === 'review' || screen === 'nextSteps') && <StepIndicator screen={screen} maxReached={maxStepReached} onNavigate={handleStepNav} />}
      <div className="flex-1 min-h-0 flex flex-col">
        {renderScreen()}
      </div>
    </div>
  );
}