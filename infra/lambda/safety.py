"""Deterministic emergency / crisis screen. Runs BEFORE the database and the model, so it is instant
and cannot be delayed or overridden by the model. Errs on the side of over-triage.

Wording is a PLACEHOLDER taken from the 'Red Flag Emergency Routing' sheet. That table is not from NICE NG12
and must be clinically validated before real use.
"""
import re

CRISIS_TEXT = ("I'm really sorry you're feeling this way, and I'm glad you told me. You don't have to face this alone. "
               "Please talk to someone right now: Samaritans are free, 24 hours a day, on 116 123. "
               "If you are in immediate danger, call 999 or go to your nearest A&E. "
               "You can also contact your GP or NHS 111 (option 2 for mental health) today.")
EMERGENCY_TEXT = ("This could be an emergency. Please call 999 or go to A&E right now. "
                  "Don't wait for a GP appointment or for this chat.")
URGENT_TEXT = ("This needs urgent medical attention. Please call NHS 111 now. "
               "If the pain is unbearable or you feel worse, call 999 or go to A&E.")

# (name, action, [regexes]); matched against lower-cased text. First match in list order wins: crisis first.
RULES = [
    ("crisis", CRISIS_TEXT, [
        r"\b(kill|killing|end|ending|take|taking)\s+(myself|my own life|my life|it all)\b", r"\bsuicid", r"\bself[- ]?harm", r"\b(hurt|harm)(ing)? myself\b",
        r"\b(better|best) off without me\b", r"\bdon'?t want to (be here|be alive|live|go on|wake up)\b",
        r"\bno (point|reason) (in )?(living|going on|continuing)\b", r"\bwant to (die|disappear)\b",
        r"\bwish i (was|were) (dead|gone)\b", r"\bthinking about (dying|ending it)\b", r"\bcan'?t (go on|take (it|this) any ?more)\b"]),
    ("chest", EMERGENCY_TEXT, [
        r"\bchest\b.{0,40}\b(crush|crushing|severe|sudden|tight|squeez|heavy|spreading|radiat)", r"\b(crushing|severe|sudden|tight|squeezing)\b.{0,30}\bchest\b",
        r"\bpain\b.{0,30}\b(left arm|jaw)\b"]),
    ("breathing", EMERGENCY_TEXT, [
        r"\b(can'?t|cannot|struggling to|unable to|hard to|difficulty) (catch my breath|breathe|breathing)\b", r"\bcan'?t (even )?(speak|talk|finish (a|my) sentence)",
        r"\bunable to speak in full sentences\b", r"\bgasping\b", r"\bshort of breath\b.{0,30}\b(severe|sudden|can'?t speak)\b"]),
    ("blood", EMERGENCY_TEXT, [
        r"\b(cough|coughing|coughed|vomit|vomiting|vomited|throwing up|threw up)\b.{0,30}\b(a lot of|large amount|lots of|large amounts|pints?|mouthful|bright red)?.{0,15}\bblood\b.{0,30}\b(a lot|large|lots|heavy|won'?t stop|pints?)?",
        r"\b(heavy|heavily|uncontrolled|won'?t stop|not stopping|can'?t stop|gushing|pouring)\b.{0,40}\b(bleed|bleeding|blood)\b", r"\b(bleed|bleeding|blood)\b.{0,40}\b(heavy|heavily|uncontrolled|won'?t stop|not stopping|can'?t stop|gushing|pouring)\b"]),
    ("head", EMERGENCY_TEXT, [
        r"\b(worst|sudden|severe|thunderclap)\b.{0,25}\bheadache\b", r"\bheadache\b.{0,60}\b(vision|confus|can'?t see|blurr)"]),
    ("sepsis", EMERGENCY_TEXT, [
        r"\bfever\b.{0,60}\b(confus|mottled|blotchy|lethargic|drowsy|can'?t stay awake)", r"\b(mottled|blotchy)\b.{0,30}\bskin\b", r"\bskin\b.{0,30}\b(mottled|blotchy)\b",
        r"\bextremely (lethargic|drowsy|sleepy)\b", r"\b(confused|confusion)\b.{0,40}\b(fever|temperature|shivering)\b"]),
    ("stroke", EMERGENCY_TEXT, [
        r"\bslurred\b", r"\bslurring\b", r"\b(face|mouth)\b.{0,25}\b(droop|drooping|dropped|dropping)\b", r"\bdroop(y|ing)\b.{0,15}\b(face|mouth|side)",
        r"\b(weak|weakness|numb|numbness|paralys)\w*\b.{0,30}\b(one side|arm and (leg|face)|left side|right side)\b", r"\b(one side|left side|right side)\b.{0,25}\b(weak|numb|paralys)"]),
    ("anaphylaxis", EMERGENCY_TEXT, [
        r"\b(throat|face|tongue|lips)\b.{0,25}\b(swell|swelling|swollen|closing)", r"\banaphyla", r"\b(swell|swelling|swollen)\b.{0,25}\b(throat|face|tongue|lips)\b"]),
    ("seizure", EMERGENCY_TEXT, [
        r"\b(seizure|seizures|fitting|convuls)\w*\b", r"\bhaving a fit\b", r"\bfirst (ever )?seizure\b"]),
    ("abdomen", URGENT_TEXT, [
        r"\b(rigid|rock[- ]?hard|hard as (a )?board|board[- ]?like)\b.{0,30}\b(stomach|abdomen|belly|tummy)\b", r"\b(stomach|abdomen|belly|tummy)\b.{0,30}\b(rigid|rock[- ]?hard|hard as (a )?board|board[- ]?like)\b",
        r"\b(severe|terrible|unbearable|excruciating)\b.{0,25}\b(stomach|abdominal|belly|tummy)\b.{0,15}\bpain\b", r"\bcan'?t move\b.{0,40}\bpain\b", r"\bpain\b.{0,40}\bcan'?t move\b"]),
]
_COMPILED = [(n, t, [re.compile(p) for p in ps]) for n, t, ps in RULES]


def screen(text):
    """Return (rule_name, fixed_reply) if the message needs an emergency/crisis response, else None."""
    t = re.sub(r"\s+", " ", text.lower().replace("’", "'"))
    for name, reply, patterns in _COMPILED:
        if any(p.search(t) for p in patterns):
            return name, reply
    return None
