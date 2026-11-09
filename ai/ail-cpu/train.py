import hashlib, json, math, os, random, time, urllib.request
from pathlib import Path
import torch
import pyarrow.parquet as pq
from torch import nn

ROOT = Path(__file__).resolve().parents[2]
OUT = Path("artifacts/ail-cpu")
OUT.mkdir(parents=True, exist_ok=True)
SEED = 42  # reproducible first AIL CPU experiment
random.seed(SEED)
torch.manual_seed(SEED)
torch.set_num_threads(2)
DEVICE = torch.device("cpu")
SEQ = 128
BATCH = 16
STEPS = int(os.getenv("AIL_STEPS", "300"))
LR = 3e-4

# Pin the published WikiText-2 raw training parquet to a known dataset revision.
# The former raw.githubusercontent.com URL no longer exists (HTTP 404).
WIKI_URL = "https://huggingface.co/datasets/Salesforce/wikitext/resolve/6231e49f19a707241d6b84d9cff60a3a86b85a85/wikitext-2-raw-v1/train-00000-of-00001.parquet"
wiki_path = Path("wiki-train.parquet")
wiki = ""
try:
    if not wiki_path.exists():
        print("Downloading WikiText-2 training split from Hugging Face...", flush=True)
        request = urllib.request.Request(WIKI_URL, headers={"User-Agent": "AIL-AI-training/1.0"})
        with urllib.request.urlopen(request, timeout=90) as response, wiki_path.open("wb") as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
    if wiki_path.stat().st_size < 100_000:
        raise RuntimeError("WikiText download is unexpectedly small")
    table = pq.read_table(wiki_path, columns=["text"])
    wiki = "\\n".join(value or "" for value in table.column("text").to_pylist())
    if len(wiki) < 100_000:
        raise RuntimeError("WikiText dataset contains too little text")
    print(f"WikiText-2 loaded: {len(wiki):,} characters", flush=True)
except Exception as exc:
    print(f"WARNING: WikiText download/read failed ({exc}); continuing with CHEATLAB source corpus only.", flush=True)
    wiki = ""
    if wiki_path.exists():
        wiki_path.unlink()
code_parts = []
for folder in (ROOT / "worker", ROOT / "public", ROOT / "docs"):
    if not folder.exists():
        continue
    for path in folder.rglob("*"):
        if path.is_file() and path.suffix.lower() in {".js", ".mjs", ".ts", ".html", ".css", ".md", ".sql", ".json", ".py"}:
            if any(part in {"node_modules", ".git", "dist", "build"} for part in path.parts):
                continue
            try:
                code_parts.append(path.read_text(encoding="utf-8", errors="ignore")[:100_000])
            except OSError:
                pass
code_text = "\n\n".join(code_parts)
# Byte-level tokenizer: no external tokenizer download or hidden vocabulary.
corpus = (wiki[:5_000_000] + "\n\n--- CHEATLAB SOURCE CODE ---\n\n" + code_text[:2_000_000]).encode("utf-8")
data = torch.tensor(list(corpus), dtype=torch.long)
split = int(len(data) * 0.95)
train_data, val_data = data[:split], data[split:]
if len(train_data) < SEQ * 100:
    raise RuntimeError(f"Training corpus is too small ({len(train_data)} bytes); refusing to train on an empty dataset")
print(f"Corpus bytes: {len(data):,}; source files: {len(code_parts)}; steps: {STEPS}")

def batch(source):
    ix = torch.randint(0, len(source) - SEQ - 1, (BATCH,))
    x = torch.stack([source[i:i+SEQ] for i in ix])
    y = torch.stack([source[i+1:i+SEQ+1] for i in ix])
    return x.to(DEVICE), y.to(DEVICE)

class AILSmall(nn.Module):
    def __init__(self):
        super().__init__()
        self.token = nn.Embedding(256, 128)
        self.position = nn.Embedding(SEQ, 128)
        layer = nn.TransformerEncoderLayer(d_model=128, nhead=4, dim_feedforward=384, dropout=0.1, batch_first=True, norm_first=True, activation="gelu")
        self.blocks = nn.TransformerEncoder(layer, num_layers=2, enable_nested_tensor=False)
        self.norm = nn.LayerNorm(128)
        self.head = nn.Linear(128, 256, bias=False)
        self.head.weight = self.token.weight
    def forward(self, x, targets=None):
        _, length = x.shape
        pos = torch.arange(length, device=x.device)
        h = self.token(x) + self.position(pos)[None, :, :]
        mask = torch.triu(torch.ones(length, length, device=x.device, dtype=torch.bool), diagonal=1)
        h = self.blocks(h, mask=mask)
        logits = self.head(self.norm(h))
        loss = nn.functional.cross_entropy(logits.reshape(-1, 256), targets.reshape(-1)) if targets is not None else None
        return logits, loss

model = AILSmall().to(DEVICE)
params = sum(p.numel() for p in model.parameters())
optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=0.1)
metrics = OUT / "metrics.jsonl"
start = time.time()
best = float("inf")
for step in range(1, STEPS + 1):
    model.train()
    x, y = batch(train_data)
    _, loss = model(x, y)
    optimizer.zero_grad(set_to_none=True)
    loss.backward()
    nn.utils.clip_grad_norm_(model.parameters(), 1.0)
    optimizer.step()
    if step == 1 or step % 25 == 0 or step == STEPS:
        model.eval()
        with torch.no_grad():
            vals = [model(*batch(val_data))[1].item() for _ in range(8)]
        val_loss = sum(vals) / len(vals)
        record = {"step": step, "steps": STEPS, "train_loss": round(loss.item(), 5), "validation_loss": round(val_loss, 5), "elapsed_seconds": round(time.time()-start, 1), "parameters": params}
        with metrics.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
        print(json.dumps(record), flush=True)
        if val_loss < best:
            best = val_loss
            torch.save({"state_dict": model.state_dict(), "config": {"vocab_size":256,"seq_len":SEQ,"d_model":128,"layers":2,"heads":4,"parameters":params},"step":step,"validation_loss":val_loss}, OUT / "checkpoint-best.pt")
torch.save({"state_dict": model.state_dict(), "config": {"vocab_size":256,"seq_len":SEQ,"d_model":128,"layers":2,"heads":4,"parameters":params},"step":STEPS}, OUT / "checkpoint-final.pt")
(OUT / "model-card.json").write_text(json.dumps({
    "name":"AIL AI CPU experiment",
    "status":"experimental",
    "parameters":params,
    "training_steps":STEPS,
    "tokenizer":"UTF-8 byte-level",
    "training_data":["WikiText-2 train split (Salesforce WikiText; attribution required)","CHEATLAB repository source files"],
    "compute":"GitHub Actions CPU",
    "limitations":"Small from-scratch prototype; not a 1B model and not suitable to represent production coding capability."
}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"TRAINING_FINISHED parameters={params} best_validation_loss={best:.5f} seconds={time.time()-start:.1f}", flush=True)
