# ai-bridge is CLARITY's local, sovereign fallback for the chatbot: a
# llama.cpp GGUF model served over HTTP, with a JSONL knowledge store that
# acts as the local "training" layer. New Q&A pairs added via /train are
# retrieved by keyword match and injected into the model's context window
# at inference time (retrieval-augmented generation) — this is the correct
# way to grow a local llama.cpp model's effective knowledge without a GPU
# fine-tuning pipeline, and it works today with CPU-only inference.
import json
import os
import re
import threading
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MODEL_PATH = os.getenv("MODEL_PATH", "/app/models/model.gguf")
N_CTX = int(os.getenv("N_CTX", "4096"))
N_THREADS = int(os.getenv("N_THREADS", str(os.cpu_count() or 4)))
DATA_PATH = Path(os.getenv("TRAIN_DATA_PATH", "/app/data/moving_context.jsonl"))
DATA_PATH.parent.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Clarity ai-bridge")

_llm = None
_llm_lock = threading.Lock()
_load_error: Optional[str] = None


def get_llm():
    global _llm, _load_error
    if _llm is not None:
        return _llm
    with _llm_lock:
        if _llm is not None:
            return _llm
        if not Path(MODEL_PATH).exists():
            _load_error = f"model file not found at {MODEL_PATH}"
            return None
        try:
            from llama_cpp import Llama
            _llm = Llama(model_path=MODEL_PATH, n_ctx=N_CTX, n_threads=N_THREADS)
            _load_error = None
        except Exception as exc:  # noqa: BLE001
            _load_error = f"failed to load model: {exc}"
            _llm = None
    return _llm


class ChatTurn(BaseModel):
    role: str
    text: str


class InferRequest(BaseModel):
    prompt: str
    system: Optional[str] = None
    history: List[ChatTurn] = []
    max_tokens: int = 384


class InferResponse(BaseModel):
    reply: str


class TrainEntry(BaseModel):
    prompt: str
    response: str
    tags: List[str] = []


def _tokenize(text: str) -> List[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def retrieve_context(query: str, top_k: int = 3) -> List[dict]:
    if not DATA_PATH.exists():
        return []
    query_tokens = set(_tokenize(query))
    if not query_tokens:
        return []

    scored = []
    with DATA_PATH.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            entry_tokens = set(_tokenize(entry.get("prompt", "") + " " + " ".join(entry.get("tags", []))))
            overlap = len(query_tokens & entry_tokens)
            if overlap > 0:
                scored.append((overlap, entry))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [entry for _, entry in scored[:top_k]]


@app.post("/train", status_code=201)
def train(entry: TrainEntry):
    with DATA_PATH.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry.model_dump()) + "\n")
    return {"ok": True, "stored": True}


@app.post("/infer", response_model=InferResponse)
def infer(req: InferRequest):
    llm = get_llm()
    if llm is None:
        raise HTTPException(status_code=503, detail=_load_error or "model not loaded")

    context_hits = retrieve_context(req.prompt)
    context_block = ""
    if context_hits:
        lines = [f"- Q: {c['prompt']}\n  A: {c['response']}" for c in context_hits]
        context_block = "\nRelevant CLARITY knowledge base entries:\n" + "\n".join(lines)

    system_prompt = (req.system or "You are the CLARITY Movers assistant.") + context_block

    messages = [{"role": "system", "content": system_prompt}]
    for turn in req.history[-10:]:
        role = "assistant" if turn.role == "assistant" else "user"
        messages.append({"role": role, "content": turn.text})
    messages.append({"role": "user", "content": req.prompt})

    try:
        output = llm.create_chat_completion(messages=messages, max_tokens=req.max_tokens)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"inference failed: {exc}") from exc

    reply = output["choices"][0]["message"]["content"].strip()
    if not reply:
        raise HTTPException(status_code=500, detail="empty model output")
    return InferResponse(reply=reply)


@app.get("/health")
def health():
    llm = get_llm()
    return {
        "ok": True,
        "service": "ai-bridge",
        "model_loaded": llm is not None,
        "model_path": MODEL_PATH,
        "load_error": _load_error,
        "knowledge_entries": sum(1 for _ in DATA_PATH.open("r", encoding="utf-8")) if DATA_PATH.exists() else 0,
    }
