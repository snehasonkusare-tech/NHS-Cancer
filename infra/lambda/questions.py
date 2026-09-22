"""Pick the next intake question from the workbook's Guided_Question_Bank.

The bank holds 33 clinically-authored question sets, each with four ordered questions and a note
on why they matter. Letting the fine-tuned model choose its own questions went wrong in two ways:
it drifted to the wrong symptom's risk factor (asking a patient with rectal bleeding about alcohol,
which belongs to the swollen-glands row) and it asked for details already on the record.

So the bank drives the conversation and the model is only a fallback. The questions are NHS-authored
and already in plain English, so they are asked verbatim rather than paraphrased.
"""
import re

SHEET = "Guided_Question_Bank"
# Below this the nearest bank row is not really about what the patient described, so defer to the model.
MATCH_FLOOR = 0.42

QUESTION_KEYS = [
    "Question 1 (demographic)",
    "Question 2 (duration/pattern)",
    "Question 3 (associated symptoms)",
    "Question 4 (specific risk factor)",
]

# Question 1 is almost always "How old are you?", which the patient record already answers.
AGE_QUESTION = re.compile(r"how old|your age|age are you", re.I)


def _already_asked(q, history):
    """True when this question (or something very close) has already been put to the patient."""
    norm = lambda t: re.sub(r"[^a-z ]", "", t.lower()).strip()
    asked = [norm(t["content"]) for t in history if t["role"] == "assistant"]
    n = norm(q)
    return any(n == a or (len(n) > 20 and n in a) for a in asked)


# (what the question is asking about, how the patient would already have said it). Asking again for
# something they just told us wastes one of very few turns and reads as though we weren't listening.
TOPIC_CUES = [
    (re.compile(r"how long|days, weeks|been going on|duration", re.I),
     re.compile(r"\b(day|days|week|weeks|month|months|year|years|since)\b", re.I)),
    (re.compile(r"ever smoked|do you smoke|smoking", re.I),
     re.compile(r"\bsmok\w*|cigarett\w*|vape\w*|non-?smoker\b", re.I)),
    (re.compile(r"weight loss|lost weight", re.I),
     re.compile(r"\b(lost|losing|loss of)\s+(\w+\s+){0,2}weight|weight\s+loss\b", re.I)),
    (re.compile(r"how old|your age", re.I),
     re.compile(r"\bI(?:'m| am)\s+\d{1,3}\b|\b\d{1,3}\s+years?\s+old\b", re.I)),
    # Switching between the bowel rows otherwise re-asks what the other row already established.
    (re.compile(r"bowel habit|more frequent, looser|looser, more frequent", re.I),
     re.compile(r"\bloose\w*|constipat\w*|diarrh\w*|bowel habit|more frequent|runny\b", re.I)),
    (re.compile(r"blood in your (stool|poo|urine|wee)|noticed any blood", re.I),
     re.compile(r"\bblood\b|\bbleed\w*", re.I)),
]


def _answered(q, said):
    """True when the patient's own words already cover what this question asks."""
    if not said:
        return False
    return any(asks.search(q) and told.search(said) for asks, told in TOPIC_CUES)


def next_question(row, age, history, said=""):
    """The next bank question to ask, or None when the set is exhausted.
    `said` is everything the patient has typed, including the message being answered right now."""
    for key in QUESTION_KEYS:
        q = (row.get(key) or "").strip()
        if not q or q.lower() == "none":
            continue
        # The record already gives us their age, so asking wastes one of very few turns.
        if age is not None and AGE_QUESTION.search(q):
            continue
        if _already_asked(q, history) or _answered(q, said):
            continue
        return q
    return None


def lead_in(history):
    """A two-word acknowledgement prefixed to the first question so the chat doesn't open abruptly.
    It goes in the same message as the question — announcing that questions are coming would burn
    one of the few turns before the summary."""
    return "" if any(t["role"] == "assistant" for t in history) else "Thank you. "
