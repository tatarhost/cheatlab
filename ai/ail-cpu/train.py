import json, math, os, random, time, urllib.request
from pathlib import Path
import torch
import pyarrow.parquet as pq
from torch import nn

ROOT = Path(__file__).resolve().parents[2]
OUT = Path("artifacts/ail-cpu"); OUT.mkdir(parents=True, exist_ok=True)
STATE = Path("ai/ail-cpu/state"); STATE.mkdir(parents=True, exist_ok=True)
SEED = 42
random.seed(SEED); torch.manual_seed(SEED); torch.set_num_threads(2)
DEVICE = torch.device("cpu")
SEQ, BATCH, LR = 128, 12, 3e-4
STEPS = int(os.getenv("AIL_STEPS", "300"))
WIKI_URL = "https://huggingface.co/datasets/Salesforce/wikitext/resolve/6231e49f19a707241d6b84d9cff60a3a86b85a85/wikitext-2-raw-v1/train-00000-of-00001.parquet"
wiki_path = STATE / "wiki-train.parquet"
wiki = ""
try:
    if not wiki_path.exists():
        print("Downloading WikiText-2 corpus (data only; no pretrained model)...", flush=True)
        req = urllib.request.Request(WIKI_URL, headers={"User-Agent":"AIL-AI-training/1.0"})
        with urllib.request.urlopen(req, timeout=120) as src, wiki_path.open("wb") as dst:
            while chunk := src.read(1024*1024): dst.write(chunk)
    table = pq.read_table(wiki_path, columns=["text"])
    wiki = "\n".join(x or "" for x in table.column("text").to_pylist())
    if len(wiki) < 100_000: raise RuntimeError("dataset too small")
    print(f"Corpus loaded: {len(wiki):,} chars", flush=True)
except Exception as exc:
    print(f"WikiText unavailable: {exc}; using repository corpus", flush=True)
code_parts = []
for folder in (ROOT/"worker", ROOT/"public", ROOT/"docs", ROOT/"ai"):
    if folder.exists():
        for p in folder.rglob("*"):
            if p.is_file() and p.suffix.lower() in {".py",".js",".ts",".html",".css",".md",".sql",".json"} and "state" not in p.parts and "node_modules" not in p.parts:
                try: code_parts.append(p.read_text(encoding="utf-8",errors="ignore")[:50000])
                except OSError: pass
corpus = (wiki[:4_000_000] + "\n\n--- CHEATLAB SOURCE ---\n\n" + "\n".join(code_parts)[:1_000_000]).encode("utf-8")
data = torch.tensor(list(corpus),dtype=torch.long)
cut = int(len(data)*.95); train_data,val_data=data[:cut],data[cut:]
if len(train_data)<SEQ*100 or len(val_data)<SEQ*2: raise RuntimeError(f"Corpus too small: {len(data)} bytes")
def batch(src):
    ix=torch.randint(0,len(src)-SEQ-1,(BATCH,))
    x=torch.stack([src[i:i+SEQ] for i in ix]); y=torch.stack([src[i+1:i+SEQ+1] for i in ix])
    return x.to(DEVICE),y.to(DEVICE)
class AILSmall(nn.Module):
    def __init__(self):
        super().__init__()
        self.token=nn.Embedding(256,128); self.position=nn.Embedding(SEQ,128)
        layer=nn.TransformerEncoderLayer(d_model=128,nhead=4,dim_feedforward=384,dropout=.1,batch_first=True,norm_first=True,activation="gelu")
        self.blocks=nn.TransformerEncoder(layer,num_layers=2,enable_nested_tensor=False)
        self.norm=nn.LayerNorm(128); self.head=nn.Linear(128,256,bias=False); self.head.weight=self.token.weight
    def forward(self,x,y=None):
        n=x.shape[1]; pos=torch.arange(n,device=x.device)
        h=self.token(x)+self.position(pos)[None,:,:]
        mask=torch.triu(torch.ones(n,n,device=x.device,dtype=torch.bool),diagonal=1)
        logits=self.head(self.norm(self.blocks(h,mask=mask)))
        loss=nn.functional.cross_entropy(logits.reshape(-1,256),y.reshape(-1)) if y is not None else None
        return logits,loss
model=AILSmall().to(DEVICE); params=sum(p.numel() for p in model.parameters())
opt=torch.optim.AdamW(model.parameters(),lr=LR,weight_decay=.1)
resume=STATE/"latest.pt"; start_step=0; best=float("inf")
if resume.exists():
    ck=torch.load(resume,map_location=DEVICE,weights_only=False)
    if ck.get("config",{}).get("parameters",params)!=params:
        raise RuntimeError("Checkpoint architecture mismatch; refusing unsafe resume")
    model.load_state_dict(ck["model"]); opt.load_state_dict(ck["optimizer"])
    start_step=int(ck["step"]); best=float(ck.get("best_loss",best))
    print(f"Resumed model + optimizer from global step {start_step}",flush=True)
else: print("Initialized AIL model from random weights (no pretrained model)",flush=True)
metrics_path=STATE/"metrics-history.jsonl"
if not metrics_path.exists(): metrics_path.write_text("",encoding="utf-8")
started=time.time(); final_step=start_step+STEPS
for local in range(1,STEPS+1):
    model.train(); x,y=batch(train_data); _,loss=model(x,y)
    opt.zero_grad(set_to_none=True); loss.backward(); nn.utils.clip_grad_norm_(model.parameters(),1.0); opt.step()
    if local==1 or local%25==0 or local==STEPS:
        model.eval()
        with torch.no_grad(): val=sum(model(*batch(val_data))[1].item() for _ in range(5))/5
        step=start_step+local
        rec={"step":step,"session_steps":STEPS,"train_loss":round(loss.item(),5),"validation_loss":round(val,5),"parameters":params,"elapsed_seconds":round(time.time()-started,1),"updated_at":int(time.time())}
        with metrics_path.open("a",encoding="utf-8") as f: f.write(json.dumps(rec)+"\n")
        print(json.dumps(rec),flush=True)
        if val<best:
            best=val
            torch.save({"model":model.state_dict(),"config":{"vocab_size":256,"seq_len":SEQ,"d_model":128,"layers":2,"heads":4,"parameters":params},"step":step,"best_loss":best},OUT/"checkpoint-best.pt")
        torch.save({"model":model.state_dict(),"optimizer":opt.state_dict(),"config":{"parameters":params,"seq_len":SEQ,"d_model":128,"layers":2,"heads":4},"step":step,"best_loss":best},resume)
torch.save({"model":model.state_dict(),"optimizer":opt.state_dict(),"config":{"parameters":params,"seq_len":SEQ,"d_model":128,"layers":2,"heads":4},"step":final_step,"best_loss":best},OUT/"checkpoint-final.pt")
last=rec
summary={"name":"AIL AI from-scratch CPU prototype","status":"session_completed","parameters":params,"total_steps":final_step,"session_steps":STEPS,"train_loss":last["train_loss"],"validation_loss":last["validation_loss"],"best_validation_loss":round(best,5),"elapsed_seconds":round(time.time()-started,1),"updated_at":last["updated_at"],"compute":"GitHub Actions CPU","initialized_from_random_weights":True,"pretrained_model_used":False,"note":"Small experimental byte-level model; not a production assistant or 1B model."}
(OUT/"model-card.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
Path("public/ail-training-metrics.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding="utf-8")
print("TRAINING_SESSION_FINISHED "+json.dumps(summary),flush=True)
