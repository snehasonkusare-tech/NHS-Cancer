"""Personalised appointment preparation, built only from the workbook (no model-written medical content).

NG12 rows describe what a GP is likely to do for the patient's symptoms; each action is mapped to the matching
'Preparation Support' entry, whose Before / Day of / What to bring / After text is returned verbatim.
"""
import re

GENERIC = "Assess for additional symptoms/signs/findings to clarify investigation or referral needed"
MONITOR = "Assess for other clinical causes / monitor in primary care"

# (regex on the NICE action text, test names in Preparation Support)
ACTION_RULES = [
    (r"\bfit\b|faecal immunochemical", ["FIT"]),
    (r"ca[- ]?125", ["CA-125"]),
    (r"chest x-?ray|\bcxr\b", ["CXR"]),
    (r"\bpsa\b.*(rectal|dre)|(rectal|dre).*\bpsa\b", ["PSA + DRE"]),
    (r"\bpsa\b", ["PSA"]),
    (r"full blood count|\bfbc\b", ["FBC"]),
    (r"endoscop|\bogd\b|gastroscop", ["Routine OGD"]),
    (r"\bmri\b|ct of the brain|brain.*(ct|mri)", ["MRI/CT brain"]),
    (r"ultrasound|\buss\b", ["Direct access USS"]),
    (r"\bct\b", ["CT/USS"]),
    (r"x-?ray", ["X-ray"]),
    (r"dental", ["Dental appointment"]),
    (r"ophthalm", ["Referral to ophthalmologist"]),
    (r"paediatric", ["Referral to paediatrician"]),
    (r"urine protein|bence", ["Urine Protein Electrophoresis and BJP"]),
    (r"paraprotein|light chain|calcium.*esr", ["FBC, calcium, ESR/PV, paraproteins, free light chains"]),
]
# 'refer using a suspected cancer pathway' -> specialist entry, chosen from the NICE 'Possible Cancer' text
SITE_RULES = [
    (r"ovar|gynae|endometri|cervi|vulv|vagin|uterin", "Gynaecology"),
    (r"colorectal|bowel|lower gi|anal|rectal", "Lower GI"),
    (r"oesophag|stomach|gastric|upper gi|pancrea|liver|biliary|gallbladder", "Upper GI"),
    (r"lung|mesothelioma|pleural", "Lung"),
    (r"breast", "Breast"),
    (r"skin|melanoma|basal|squamous cell", "Skin"),
    (r"bladder|kidney|renal|prostate|testic|penile|urolog", "Urology"),
    (r"laryn|head and neck|oral|thyroid|nasopharyn|neck", "Head + Neck"),
    (r"leuk|lymphoma|myeloma|haemat", "Haematology"),
    (r"sarcoma|bone", "Sarcoma"),
]


def parse_row(text):
    out = {}
    for part in text.split(" | "):
        k, sep, v = part.partition(": ")
        if sep:
            out[k.strip()] = v.strip()
    return out


def tests_for(nice_row):
    """Names of Preparation Support entries suggested by one NICE row."""
    action = nice_row.get("NICE Recommended Action", "")
    cancer = nice_row.get("Possible Cancer", "")
    symptom = nice_row.get("Symptom / Specific Features", "")
    low = action.lower()
    names = []
    for pat, tests in ACTION_RULES:
        if re.search(pat, low):
            names += ["Abdominal and pelvic USS" if t == "Direct access USS" and re.search(r"abdom|pelvi|distension", symptom.lower()) else t for t in tests]
    if re.search(r"suspected cancer pathway|urgent|2ww|two[- ]week", low):
        site = next((name for pat, name in SITE_RULES if re.search(pat, (cancer + " " + symptom).lower())), None)
        if site:
            names.append(site)
    if not names and re.search(r"monitor|primary care|consider|assess", low):
        names.append(MONITOR)
    return names or [GENERIC]


def eligible(row, age, sex):
    """Drop NICE rows that only apply to a different age or sex than this patient's (None = unknown, keep)."""
    s = (row.get("Symptom / Specific Features", "") + " " + row.get("Possible Cancer", "")).lower()
    if age is not None:
        for m in re.finditer(r"(\d+)\+", s):
            if age < int(m.group(1)):
                return False
        m = re.search(r"(?:under|<)\s*(\d+)", s)
        if m and age >= int(m.group(1)):
            return False
        if "young people" in s and age >= 25:
            return False
        if re.search(r"\bchild(ren)?\b", s) and "young people" not in s and age >= 16:
            return False
    if sex:
        female = sex.lower().startswith("f")
        s = s.replace("trans men", "").replace("non-binary", "")  # 'women/trans men/non-binary' means people with female organs
        for_women = re.search(r"women|female|vulval|vagin|ovar|cervi|endometri|uterin|gynae|breast", s)
        for_men = re.search(r"\bmen\b|\bmale\b|testic|prostate|penile|scrot", s)
        if for_women and not for_men and not female and "breast" not in s:
            return False
        if for_men and not for_women and female:
            return False
    return True


# When two entries would cover the same ground, keep the more specific one.
REDUNDANT = {"X-ray": "CXR", "CT/USS": "Direct access USS", "Direct access USS": "Abdominal and pelvic USS"}


def build_items(nice_rows, prep_lookup, limit=4):
    """nice_rows: parsed NICE rows, best match first. prep_lookup(name) -> parsed Preparation Support row or None."""
    items, seen = [], set()
    for row in nice_rows:
        for name in tests_for(row):
            if name in seen:
                continue
            prep = prep_lookup(name)
            if not prep:
                continue
            seen.add(name)
            if REDUNDANT.get(name) in seen or name in seen and False:
                continue
            action = row.get("NICE Recommended Action", "")
            ref = row.get("NICE Recommendation Number(s)", "")
            items.append({
                "test": name,
                "category": prep.get("Category", ""),
                "cancer": row.get("Possible Cancer", ""),
                "why": f"For symptoms like “{row.get('Symptom / Specific Features', '')}”, NICE NG12 advises: {action}" + (f" (NG12 {ref})" if ref else ""),
                "before": prep.get("Before", ""),
                "day_of": prep.get("Day of / what happens", ""),
                "bring": prep.get("What to bring", ""),
                "after": prep.get("After / follow-up", ""),
            })
            if len(items) >= limit:
                return items
    return items


# ── Safety netting needs positive evidence of a mild, self-limiting picture, not just "no NG12 row matched" ──
MILD_CUES = re.compile(r"\b(occasional(ly)?|mild(ly)?|comes and goes|on and off|settles|goes away|nothing else|no other symptoms|"
                       r"cleared up|back to normal|just the one|only once|once or twice|rarely|resolved|got better|improved)\b", re.I)
WARNING_WORDS = (r"yellow|jaundice|mole|lump|swell|swollen|bleed|blood|weight loss|lost weight|losing weight|night sweat|sweats|"
                 r"getting bigger|growing|changed|changing|ulcer|won'?t heal|swallow|hoarse|cough|breathless|short of breath|dark urine|"
                 r"black stool|appetite|persistent|for (weeks|months)|more than a month|unexplained|worsening|getting worse")
_NEGATED = re.compile(r"\b(?:no|not|never|without|\w+n['’]t)\s+(?:\w+\s+){0,2}?(?:" + WARNING_WORDS + r")", re.I)
_WARNING = re.compile(WARNING_WORDS, re.I)


def is_mild(text):
    return bool(MILD_CUES.search(text))


def has_warning(text):
    """True if the text mentions a warning feature that has not been denied ('no blood', 'I haven't lost weight')."""
    return bool(_WARNING.search(_NEGATED.sub(" ", text)))
