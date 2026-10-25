"""Private Korean syntactic analysis service. It never infers irony from token counts."""
from collections import Counter
from threading import Lock
import os
import stanza
import torch
from fastapi import FastAPI
from pydantic import BaseModel, Field

torch.set_num_threads(2)
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
pipeline = stanza.Pipeline(
    "ko", package="gsd", processors="tokenize,pos,lemma,depparse",
    dir=os.environ.get("STANZA_RESOURCES_DIR", "/models"),
    use_gpu=False, download_method=None, verbose=False,
)
lock = Lock()
CONTENT = {"NOUN", "PROPN", "VERB", "ADJ", "ADV", "NUM"}
NEGATION = {"안", "못", "않", "아니", "없", "말"}
STOP = {"하", "되", "있", "주", "것", "수", "그리", "만들", "보여"}

class AnalyzeInput(BaseModel):
    text: str = Field(min_length=1, max_length=1500)

def analyze_text(text: str):
    # Stanza preserves inflection, lemma, XPOS and dependency heads together.
    with lock:
        doc = pipeline(text)
    tokens, content, keywords = [], [], Counter()
    modifiers = negations = 0
    for sentence_index, sentence in enumerate(doc.sentences):
        for token in sentence.tokens:
            for word in token.words:
                lemma = word.lemma or word.text
                forms = lemma.split("+")
                tags = (word.xpos or word.upos or "").split("+")
                tokens.append({
                    "form": word.text, "lemma": lemma, "tag": word.xpos or word.upos or "",
                    "start": token.start_char, "len": token.end_char - token.start_char,
                    "head": word.head, "relation": word.deprel or "", "sentence": sentence_index,
                })
                if word.upos in CONTENT:
                    content.append(lemma)
                modifiers += int(word.upos in {"ADJ", "ADV"} or word.deprel in {"amod", "advmod", "nummod"})
                # A candidate marker count is a visible surface statistic, not a scope/irony decision.
                negations += sum(1 for form, tag in zip(forms, tags) if form in NEGATION and (tag.startswith(("MAG", "VX", "VA", "VCN"))))
                for form, tag in zip(forms, tags):
                    if tag.startswith(("NNG", "NNP", "VA", "VV")) and form not in STOP and form:
                        keywords[form] += 1
    return {
        "engine": "stanza-ko-gsd", "version": stanza.__version__, "tokens": tokens,
        "metrics": {"contentWords": len(content), "uniqueContentWords": len(set(content)),
                    "lexicalDiversity": round(len(set(content)) / len(content), 4) if content else 0,
                    "modifiers": modifiers, "negationMarkers": negations},
        "keywords": [{"word": word, "count": count} for word, count in keywords.most_common(30)],
    }

@app.post("/analyze")
def analyze(value: AnalyzeInput):
    return analyze_text(value.text)

@app.get("/health")
def health():
    return {"engine": "stanza-ko-gsd", "version": stanza.__version__, "ready": True}
