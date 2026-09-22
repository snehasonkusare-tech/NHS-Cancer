"""Is this something OncoWay can help with?

OncoWay checks symptoms against NHS NG12 (suspected cancer) guidance. Questions about anything
else get a fixed reply instead of reaching the model, which would otherwise answer them happily.

Deliberately conservative: a message is only out of scope with positive evidence that it is
off-topic AND no health signal anywhere in it. Wrongly telling an unwell person "I only do
cancer" is far worse than letting an off-topic question through to the model.
"""
import re

REPLY = ("I'm OncoWay — I help you check symptoms against NHS NG12 cancer guidance, so that one is "
         "outside what I can help with.\n\nIf you've noticed something physical you're worried about, "
         "describe it in your own words and I'll take it from there.")

GREETING_REPLY = ("Hello — I'm OncoWay. I check symptoms against NHS NG12 cancer guidance.\n\n"
                  "Please describe in your own words what you've been noticing.")

# Any of these means the person is talking about their health, so never treat the message as off-topic.
HEALTH = re.compile(r"""\b(
    pain|ache|aching|sore|hurt|lump|swell\w*|blood|bleed\w*|cough\w*|breath\w*|tired\w*|fatigue|
    weight|appetite|nausea|vomit\w*|sick|fever|night\s*sweat\w*|itch\w*|rash|mole|ulcer|sore\s*throat|
    hoarse\w*|swallow\w*|indigestion|heartburn|bowel|stool|poo|urine|wee|bladder|breast|nipple|
    testicl\w*|vagin\w*|period\w*|discharge|headache|dizzy|dizziness|numb\w*|weak\w*|lose|lost|losing|
    symptom\w*|unwell|ill|illness|disease|cancer|tumour|tumor|lesion|
    doctor|gp|nurse|hospital|clinic|surgery|referral|refer\w*|appointment|scan|x-?ray|mri|ct|biopsy|
    test\w*|result\w*|screening|smear|colonoscopy|endoscopy|treatment|medication|tablet\w*|prescription|
    diagnos\w*|worried\s+about|body|chest|stomach|abdomen|back|neck|throat|skin|lymph
)\b""", re.I | re.X)

# Positive evidence of an off-topic request. Each needs a whole-word match.
OFF_TOPIC = re.compile(r"""\b(
    weather|forecast|temperature\s+outside|rain(ing|y)?|snow(ing)?|
    football|cricket|tennis|match\s+score|world\s+cup|premier\s+league|olympics|
    recipe|cook(ing)?|bake|restaurant|pizza|takeaway|
    code|coding|python|javascript|typescript|java|sql|html|css|program(ming)?|debug|api\s+key|
    homework|essay|assignment|dissertation|translate|translation|
    joke|funny|riddle|poem|poetry|story|song|lyrics|music|movie|film|netflix|
    stock\s+price|bitcoin|crypto|invest(ing|ment)?|mortgage|tax(es)?|
    capital\s+of|president|prime\s+minister|election|politics|
    flight|hotel|holiday|booking\.com|directions\s+to|
    who\s+won|what\s+time\s+is\s+it|what\s+day\s+is|
    chatgpt|openai|which\s+model|are\s+you\s+(an?\s+)?(ai|robot|bot|human)
)\b""", re.I | re.X)

# "write me a…", "generate a…" — task requests that are never symptom descriptions.
TASK = re.compile(r"\b(write|generate|create|make)\s+(me\s+)?(a|an|some)\b", re.I)

GREETING = re.compile(
    r"^\s*(hi|hey|hello|yo|good\s+(morning|afternoon|evening)|how\s+are\s+you)"
    r"(\s+(there|oncoway|doc|doctor))?\b[\s!.,?]*$", re.I)


def check(question):
    """Returns a fixed reply when the message is out of scope, otherwise None."""
    text = (question or "").strip()
    if not text:
        return None
    if GREETING.match(text):
        return GREETING_REPLY
    if HEALTH.search(text):
        return None
    if OFF_TOPIC.search(text) or TASK.search(text):
        return REPLY
    return None
