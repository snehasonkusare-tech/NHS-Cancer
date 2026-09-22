"""POST {"patient_id": "SC-001", "question": "..."} -> {"answer": "..."}

Pipeline: Aurora (Data API) patient record -> OpenSearch hybrid (keyword + kNN) NG12 chunks
-> prompt -> SageMaker endpoint (or Bedrock if SAGEMAKER_ENDPOINT is unset).
Uses only boto3/botocore (already in the Lambda runtime), so nothing needs packaging.
"""
import json, os, re, time, urllib.request
import boto3
import safety
import prep
import scope
import questions
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

REGION = os.environ.get("AWS_REGION", "eu-west-2")
CLUSTER_ARN = os.environ["DB_CLUSTER_ARN"]
SECRET_ARN = os.environ["DB_SECRET_ARN"]
DB_NAME = os.environ.get("DB_NAME", "nhs_slm")
OS_ENDPOINT = os.environ["OPENSEARCH_ENDPOINT"]
OS_INDEX = os.environ.get("OPENSEARCH_INDEX", "nhs-ng12-kb")
SAGEMAKER_ENDPOINT = os.environ.get("SAGEMAKER_ENDPOINT", "")
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "")
TOP_K = int(os.environ.get("TOP_K", "5"))
INTAKE_TOKENS = int(os.environ.get("INTAKE_TOKENS", "256"))

rds = boto3.client("rds-data", region_name=REGION)
bedrock = boto3.client("bedrock-runtime", region_name=REGION)
smr = boto3.client("sagemaker-runtime", region_name=REGION)

SYSTEM = ("You are an NHS cancer-care onboarding assistant. Use only the information given below. "
          "Never diagnose. If unsure, say so and refer the patient to their GP or care team. "
          "Only quote guidance that appears below and never invent tests, preparation steps or arrangements. "
          "Emergency advice (999, 111) is handled elsewhere, so do not cite NG12 for emergencies. "
          "You are OncoWay and you only help with symptoms, the patient's referral and their cancer care. "
          "If they ask about anything else (weather, sport, cooking, code, general knowledge, or what model you are), "
          "do not answer it: say you are OncoWay, that the question is outside what you help with, and invite them "
          "to describe any symptom they are worried about. "
          "Speak to the patient in plain, calm language, and keep replies short.")


def _query(sql, patient_id, **extra):
    params = [{"name": "pid", "value": {"stringValue": patient_id}}] + \
             [{"name": k, "value": {"stringValue": v}} for k, v in extra.items()]
    for _ in range(12):  # Serverless v2 auto-pause: retry while the cluster resumes
        try:
            r = rds.execute_statement(resourceArn=CLUSTER_ARN, secretArn=SECRET_ARN, database=DB_NAME, sql=sql,
                                      parameters=params, formatRecordsAs="JSON")
            return json.loads(r.get("formattedRecords") or "[]")
        except rds.exceptions.DatabaseResumingException:
            time.sleep(2)
    raise RuntimeError("database is still resuming, try again shortly")


def login_lookup(nhs_number, dob):
    """NHS number + date of birth must both match. Returns only what the app needs to greet the person.
    Checks the seeded test patients first, then accounts registered through the app."""
    digits = "".join(ch for ch in nhs_number if ch.isdigit())
    if len(digits) != 10 or not dob:
        return None
    rows = _query("SELECT full_name_synthetic AS full_name, gp_practice FROM test_patients "
                  "WHERE replace(nhs_number_synthetic, ' ', '') = :pid AND date_of_birth = :dob", digits, dob=dob.strip())
    if not rows:
        rows = _query("SELECT full_name, gp_practice, postcode FROM app_users "
                      "WHERE nhs_number = :pid AND date_of_birth = :dob", digits, dob=dob.strip())
    if not rows:
        return None
    out = {"full_name": rows[0]["full_name"], "gp_practice": rows[0].get("gp_practice") or ""}
    if rows[0].get("postcode"):
        out["postcode"] = rows[0]["postcode"]
    return out


def register_user(body):
    """Create an account so the person can log back in later. Returns (payload, http_status)."""
    name = str(body.get("full_name", "")).strip()[:120]
    digits = "".join(ch for ch in str(body.get("nhs_number", "")) if ch.isdigit())
    dob = str(body.get("dob", "")).strip()[:10]
    postcode = str(body.get("postcode", "")).strip()[:10]
    gp = str(body.get("gp_practice", "")).strip()[:120]
    if not name or not dob or not gp:
        return {"error": "full_name, dob and gp_practice are required"}, 400
    if len(digits) != 10:
        return {"error": "NHS number must be 10 digits"}, 400
    # An NHS number identifies one person, so it can only belong to one account.
    if _query("SELECT 1 AS x FROM test_patients WHERE replace(nhs_number_synthetic, ' ', '') = :pid", digits) or \
       _query("SELECT 1 AS x FROM app_users WHERE nhs_number = :pid", digits):
        return {"error": "that NHS number is already registered"}, 409
    pid = f"AU-{digits}"
    _query("INSERT INTO app_users (patient_id, full_name, nhs_number, date_of_birth, postcode, gp_practice, consent) "
           "VALUES (:pid, :name, :pid2, :dob, :postcode, :gp, :consent)", pid,
           name=name, pid2=digits, dob=dob, postcode=postcode, gp=gp,
           consent="yes" if body.get("consent") else "no")
    return {"full_name": name, "gp_practice": gp, "patient_id": pid}, 200


def resolve_patient_id(patient_id, nhs_number):
    """Accept either a patient_id or an NHS number (digits, spaces ignored)."""
    if patient_id:
        return patient_id
    digits = "".join(ch for ch in nhs_number if ch.isdigit())
    if len(digits) != 10:
        return ""
    rows = _query("SELECT patient_id FROM test_patients WHERE replace(nhs_number_synthetic, ' ', '') = :pid", digits)
    if not rows:
        rows = _query("SELECT patient_id FROM app_users WHERE nhs_number = :pid", digits)
    return rows[0]["patient_id"] if rows else ""


def get_patient_record(patient_id):
    """Profile + health history + current referral. Direct identifiers (NHS number, DOB) are never fetched."""
    rows = _query("SELECT patient_id, full_name_synthetic, age, sex, preferred_language, accessibility_needs, "
                  "communication_preferences, gp_practice, presenting_symptom, suspected_site, suspected_pathway, specialty "
                  "FROM test_patients WHERE patient_id = :pid", patient_id)
    if not rows:
        # Registered through the app: no seeded clinical record, so build a minimal profile.
        app = _query("SELECT patient_id, full_name AS full_name_synthetic, gp_practice FROM app_users "
                     "WHERE patient_id = :pid", patient_id)
        if not app:
            return {}
        record = app[0]
        record["history"], record["consult"] = {}, {}
        return record
    record = rows[0]
    hist = _query("SELECT medications, allergies, past_medical_history_conditions, family_history, last_gp_encounter "
                  "FROM ehr_emr_patient_history WHERE patient_id = :pid", patient_id)
    consult = _query("SELECT consultation_date, gp_name, outcome_decision, referral_made, referral_type_pathway "
                     "FROM gp_consult_history WHERE patient_id = :pid ORDER BY consultation_date DESC LIMIT 1", patient_id)
    record["history"] = hist[0] if hist else {}
    record["consult"] = consult[0] if consult else {}
    return record


def _os_request(method, path, body):
    url = f"https://{OS_ENDPOINT}{path}"
    data = json.dumps(body).encode()
    req = AWSRequest(method=method, url=url, data=data, headers={"Content-Type": "application/json"})
    SigV4Auth(boto3.Session().get_credentials(), "es", REGION).add_auth(req)
    with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=dict(req.headers)), timeout=15) as r:
        return json.loads(r.read())


REFERRAL_WORDS = ("referral", "referred", "appointment", "2ww", "two week", "2 week", "wait", "next", "test", "scan", "prepare", "specialist", "happen")


def search_query(record, question):
    """Questions about the patient's own referral carry no symptom words, so add their symptom and pathway to the search."""
    if any(w in question.lower() for w in REFERRAL_WORDS):
        extra = " ".join(filter(None, [record.get("presenting_symptom"), record.get("suspected_site"),
                                       record.get("suspected_pathway"), record.get("specialty")]))
        return f"{question} {extra}".strip()
    return question


def retrieve_symptom_chunks(question):
    emb = json.loads(bedrock.invoke_model(modelId="amazon.titan-embed-text-v2:0", body=json.dumps(
        {"inputText": question, "dimensions": 1024, "normalize": True}))["body"].read())["embedding"]
    res = _os_request("POST", f"/{OS_INDEX}/_search", {
        "size": TOP_K, "_source": ["text", "sheet", "row_id"],
        "query": {"bool": {"should": [{"match": {"text": question}},
                                      {"knn": {"embedding": {"vector": emb, "k": TOP_K}}}]}}})
    return [h["_source"] for h in res["hits"]["hits"]]


RULES = (
    # Silently personalise from the record.
    "Use the BACKGROUND to choose your questions: age (NG12 thresholds depend on it), sex, family history, "
    "medications, allergies, and their language, accessibility and communication needs. "
    # The record already holds these facts; asking for them again wastes a turn and looks careless.
    "NEVER ask for anything the BACKGROUND already tells you - you know their age, sex, medications, allergies, "
    "past conditions and family history, so ask about the symptom instead. "
    # Family history and past conditions change which NG12 criterion applies and how urgent it is.
    "When the BACKGROUND shows a family history of cancer, or a past condition that bears on this symptom, let it "
    "steer which question you ask next and treat the symptom with the extra weight that history deserves. "
    # The record is not the conversation. Attributing it to the patient is the worst failure here:
    # it invents symptoms they never reported and destroys their trust in the summary.
    "ONLY the patient's own messages in this conversation count as things they have told you. The BACKGROUND and "
    "EXISTING REFERRAL are records, never something they said. Never write 'the other symptoms you told me about', "
    "never mention a symptom they have not typed themselves, and never suggest a new symptom is connected to an "
    "existing referral. Discuss the EXISTING REFERRAL only if they ask about their referral or appointment. "
    "If the patient states their own age or details, trust them over the record. "
    # Each reply must earn its turn: there are only a few before the summary.
    "Your reply must BE the question. Never announce that you are about to ask questions, never say you would like "
    "to ask a few things, and never ask permission: ask the single most useful question straight away. "
    # A patient who asks something and gets a question back feels unheard.
    "The one exception: if the patient asks you a question, answer it first in one short sentence, then ask yours. "
    "Ask about ONE thing only. Do not chain symptoms together with 'or': asking about breathlessness, chest pain, "
    "weight loss and appetite in one breath is four questions and will confuse them. Pick the single symptom that "
    "most changes what happens next under NG12, and ask only about that. "
    # These are patients, often frightened ones.
    "Write in plain everyday English. Never use clinical words such as 'saddle numbness', 'haematuria', 'dysphagia' "
    "or 'lymphadenopathy'; describe what you mean in ordinary words instead. Keep it to one or two short sentences. "
    "You cannot book appointments or arrange anything, so never offer to. "
    "Never reveal the record or say you can see it.")


def _first(v, default="not on file"):
    return v if v and str(v).strip() and str(v).strip().lower() != "none" else default


def _search(body):
    return [(h.get("_score") or 0, h["_source"]) for h in _os_request("POST", f"/{OS_INDEX}/_search", body)["hits"]["hits"]]


# Real NG12 matches score about 0.50 or more; symptoms with no matching criterion score about 0.40 or less.
REFER_THRESHOLD = 0.45
WEAK_MATCH = 0.40  # below this the closest NG12 rows are not really about the patient's symptoms


def nice_rows_for(text, age=None, sex=None, k=25, keep=3, closeness=0.93):
    """(rows, best_score): NICE NG12 rows for the patient's symptoms that apply to their age and sex, and only
    those nearly as relevant as the best match. best_score says how well the symptoms match any criterion."""
    emb = json.loads(bedrock.invoke_model(modelId="amazon.titan-embed-text-v2:0", body=json.dumps(
        {"inputText": text[:2000], "dimensions": 1024, "normalize": True}))["body"].read())["embedding"]
    only = {"term": {"sheet": "Symptoms_Official_NICE"}}
    hits = _search({"size": k, "_source": ["text"], "query": {"knn": {"embedding": {"vector": emb, "k": k, "filter": only}}}})
    rows = [(score, prep.parse_row(src["text"])) for score, src in hits]
    rows = [(sc, r) for sc, r in rows if prep.eligible(r, age, sex)]
    if not rows:
        return [], 0.0
    best = rows[0][0]
    return [r for sc, r in rows if sc >= best * closeness][:keep], best


def bank_row_for(text):
    """(row, score) for the Guided_Question_Bank entry closest to the patient's own words."""
    emb = json.loads(bedrock.invoke_model(modelId="amazon.titan-embed-text-v2:0", body=json.dumps(
        {"inputText": text[:2000], "dimensions": 1024, "normalize": True}))["body"].read())["embedding"]
    hits = _search({"size": 1, "_source": ["text"], "query": {"knn": {"embedding": {
        "vector": emb, "k": 1, "filter": {"term": {"sheet": questions.SHEET}}}}}})
    if not hits:
        return None, 0.0
    score, src = hits[0]
    return prep.parse_row(src["text"]), score


def prep_lookup(name):
    hits = _search({"size": 1, "_source": ["text"], "query": {"bool": {"filter": [
        {"term": {"sheet": "Preparation Support"}}, {"term": {"row_id": name}}]}}})
    return prep.parse_row(hits[0][1]["text"]) if hits else None


def build_messages(patient, chunks, question, mode="answer", history=None):
    h, c = patient.get("history", {}), patient.get("consult", {})
    first_name = (patient.get("full_name_synthetic") or "").split(" ")[0] or "the patient"
    background = (f"- Name to use: {first_name}\n- Age {patient.get('age', '?')}, {patient.get('sex', '?')}\n"
                  f"- Preferred language: {patient.get('preferred_language', 'English')}\n"
                  f"- Accessibility needs: {_first(patient.get('accessibility_needs'), 'none')}\n"
                  f"- Communication preference: {_first(patient.get('communication_preferences'))}\n"
                  f"- Medications: {_first(h.get('medications'), 'none')}\n- Allergies: {_first(h.get('allergies'), 'none known')}\n"
                  f"- Past medical history: {_first(h.get('past_medical_history_conditions'), 'nothing significant')}\n"
                  f"- Family history: {_first(h.get('family_history'), 'nothing recorded')}\n"
                  f"- Last GP visit: {_first(h.get('last_gp_encounter'))}")
    referral = (f"- Presenting symptom: {_first(patient.get('presenting_symptom'))}\n- Suspected site: {_first(patient.get('suspected_site'))}\n"
                f"- Pathway: {_first(patient.get('suspected_pathway'))} ({_first(patient.get('specialty'), 'specialty not set')})\n"
                f"- GP {_first(c.get('gp_name'))} on {_first(c.get('consultation_date'))}: {_first(c.get('outcome_decision'))}")
    guidance = "\n".join(f"- {c['text']}" for c in chunks) or "No matching symptom guidance found."
    rules = f"\n\n{RULES}" if mode == "intake" else ""
    system = (f"{SYSTEM}{rules}\n\nBACKGROUND (from the patient's record):\n{background}\n\n"
              f"EXISTING REFERRAL (only if the patient asks about it):\n{referral}\n\nRELEVANT SYMPTOM GUIDANCE (NG12):\n{guidance}")
    turns = [{"role": t["role"], "content": t["content"]} for t in (history or [])]
    asked = [t["content"] for t in turns if t["role"] == "assistant"]
    if asked:
        system += ("\n\nQUESTIONS YOU HAVE ALREADY ASKED (never ask these again, or anything close to them):\n"
                   + "\n".join(f"- {q}" for q in asked))
    return [{"role": "system", "content": system}] + turns + [{"role": "user", "content": question}]


def call_model(messages, max_new_tokens=512):
    if SAGEMAKER_ENDPOINT:  # fine-tuned Qwen3 endpoint: chat `messages` in, {"response": "..."} out
        r = smr.invoke_endpoint(EndpointName=SAGEMAKER_ENDPOINT, ContentType="application/json",
                                Body=json.dumps({"messages": messages, "max_new_tokens": max_new_tokens}))
        out = json.loads(r["Body"].read())
        if isinstance(out, list):
            out = out[0]
        if isinstance(out, str):
            out = json.loads(out)
        return out.get("response") or out.get("generated_text") or str(out)
    if BEDROCK_MODEL_ID:
        system = [{"text": messages[0]["content"]}]
        r = bedrock.converse(modelId=BEDROCK_MODEL_ID, system=system,
                             messages=[{"role": "user", "content": [{"text": messages[1]["content"]}]}],
                             inferenceConfig={"maxTokens": 512, "temperature": 0.2})
        return r["output"]["message"]["content"][0]["text"]
    raise RuntimeError("no model configured: set SAGEMAKER_ENDPOINT or BEDROCK_MODEL_ID")


def clean_history(raw):
    """Prior turns from the app: [{"role": "user"|"assistant", "content": str}], last 8 only."""
    out = []
    for t in (raw or [])[-8:]:
        if isinstance(t, dict) and t.get("role") in ("user", "assistant") and str(t.get("content", "")).strip():
            out.append({"role": t["role"], "content": str(t["content"]).strip()[:1500]})
    return out


FALLBACK_QUESTION = "Is there anything else you've noticed, even if it seems small, that we haven't covered yet?"
BAD_REPLY = re.compile(r"\b(book (you|an|the|your)|is it (okay|ok|helpful)|shall i book|arrange (an|the|your))\b", re.I)


def _norm(t):
    return re.sub(r"[^a-z ]", "", t.lower()).strip()


def guard_reply(answer, history, retry):
    """Stop the model repeating an earlier question or offering things it cannot do: one retry, then a safe fallback."""
    prior = {_norm(t["content"]) for t in history if t["role"] == "assistant"}
    for attempt in (answer, None):
        candidate = attempt if attempt is not None else retry()
        if _norm(candidate) not in prior and not BAD_REPLY.search(candidate):
            return candidate
    return FALLBACK_QUESTION


def _resp(code, body):
    return {"statusCode": code, "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
            "body": json.dumps(body)}


def lambda_handler(event, context):
    try:
        body = json.loads(event.get("body") or "{}") if isinstance(event.get("body"), (str, type(None))) else event["body"]
        patient_id, question = str(body.get("patient_id", "")).strip(), str(body.get("question", "")).strip()
        if body.get("mode") == "prepare":
            text = str(body.get("text", "")).strip()[:2000]
            if not text:
                return _resp(400, {"error": "text is required"})
            age = sex = None
            pid = resolve_patient_id(str(body.get("patient_id", "")).strip(), str(body.get("nhs_number", "")))
            if pid:
                rec = _query("SELECT age, sex FROM test_patients WHERE patient_id = :pid", pid)
                if rec:
                    age = int(rec[0]["age"]) if str(rec[0].get("age", "")).isdigit() else None
                    sex = rec[0].get("sex")
            rows, best = nice_rows_for(text, age, sex)
            # Safety netting only with positive evidence the picture is mild: no NG12 criterion matched AND the patient
            # describes something mild/self-limiting AND mentions no warning feature. Anything else goes to the GP.
            if best < REFER_THRESHOLD and prep.is_mild(text) and not prep.has_warning(text):
                return _resp(200, {"outcome": "safetynet", "items": []})
            # Weak matches would suggest unrelated tests, so show none; the app then shows its general GP-review guidance.
            return _resp(200, {"outcome": "refer", "items": prep.build_items(rows, prep_lookup) if best >= WEAK_MATCH else []})
        if body.get("mode") == "register":
            payload, status = register_user(body)
            return _resp(status, payload)
        if body.get("mode") == "login":
            found = login_lookup(str(body.get("nhs_number", "")), str(body.get("dob", "")))
            return _resp(200, found) if found else _resp(404, {"error": "no matching patient"})
        hit = safety.screen(question) if question else None
        if hit:  # emergency / crisis: fixed reply, no database or model involved
            print("safety rule:", hit[0])
            return _resp(200, {"patient_id": patient_id, "answer": hit[1], "safety": hit[0], "sources": []})
        if body.get("safety_only"):  # fast screen used by the app before its own flow; no database/model
            return _resp(200, {"safety": None, "answer": ""})
        off = scope.check(question)
        if off:  # not about their health: say what OncoWay is for instead of letting the model answer it
            return _resp(200, {"patient_id": patient_id, "answer": off, "scope": "out", "sources": []})
        if not question or not (patient_id or body.get("nhs_number")):
            return _resp(400, {"error": "question and patient_id (or nhs_number) are required"})
        patient_id = resolve_patient_id(patient_id, str(body.get("nhs_number", "")))
        if not patient_id:
            return _resp(404, {"error": "no matching patient"})
        record = get_patient_record(patient_id)
        if not record:
            return _resp(404, {"error": f"no patient found with id {patient_id}"})
        history = clean_history(body.get("history"))
        chunks = retrieve_symptom_chunks(search_query(record, question + " " + " ".join(t["content"] for t in history if t["role"] == "user")))
        mode = "intake" if body.get("mode") == "intake" else "answer"
        # A patient asking us something needs an answer, not another question, so those go to the model.
        if mode == "intake" and "?" not in question:
            said = " ".join([t["content"] for t in history if t["role"] == "user"] + [question])
            row, score = bank_row_for(said)
            if row and score >= questions.MATCH_FLOOR:
                age = int(record["age"]) if str(record.get("age", "")).isdigit() else None
                nxt = questions.next_question(row, age, history, said)
                src = [f"{questions.SHEET}:{row.get('Presenting Symptom', '')}"]
                if nxt:
                    return _resp(200, {"patient_id": patient_id, "answer": questions.lead_in(history) + nxt,
                                       "bank": row.get("Presenting Symptom", ""), "sources": src})
                # The vetted set is exhausted. Letting the model improvise another question here produced
                # weak and sometimes falsely reassuring replies, so go straight to the summary instead.
                if any(t["role"] == "assistant" for t in history):
                    return _resp(200, {"patient_id": patient_id, "done": True, "bank": row.get("Presenting Symptom", ""),
                                       "answer": "Thank you — that gives me a clear enough picture. Let me put together "
                                                 "a summary and check it against NHS NG12 guidance.", "sources": src})
        # One short follow-up question needs far fewer tokens than a full answer, and generation
        # time is what pushes slow requests towards the 29s API Gateway limit.
        cap = INTAKE_TOKENS if mode == "intake" else 512
        ask = lambda: call_model(build_messages(record, chunks, question, mode, history), cap)
        answer = guard_reply(ask(), history, ask)
        return _resp(200, {"patient_id": patient_id, "answer": answer, "sources": [f"{c['sheet']}:{c['row_id']}" for c in chunks]})
    except Exception as e:  # keep patient data out of error responses
        print("error:", repr(e))
        return _resp(500, {"error": "internal error"})


if __name__ == "__main__":
    print(lambda_handler({"body": json.dumps({"patient_id": "SC-001", "question": "What does a 2 week wait mean?"})}, None))
