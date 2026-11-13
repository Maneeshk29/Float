"""Ask a Qwen VL model on the GB10 'flood or not' for a list of images, in parallel."""
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd
from openai import OpenAI
from utils import preprocess_image_to_data_url

client = OpenAI(base_url="http://10.246.100.230/v1", api_key=os.environ["GB10_API_KEY"], timeout=180, max_retries=3)
DATA_DIR = Path("flood_data")
QUESTION = 'This aerial photo is from southeast Texas around Hurricane Harvey. Decide whether it shows FLOODING. Signs of flooding: brown or muddy standing water spread across fields, yards, roads, parking lots or between trees; a river or creek that has spilled past its banks; water with no clear channel shape; partly submerged trees, fences or buildings. NOT flooding: a river, creek, canal, pond or pool sitting inside its normal banks with dry land around it. Reply with exactly one word on the first line: FLOOD, NOT_FLOOD or UNCERTAIN. On the second line give one short visible clue.'

def ask(model, row):
    url = preprocess_image_to_data_url(str(DATA_DIR / row["image_path"]), max_side=1024)
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": [{"type": "text", "text": QUESTION},
                                               {"type": "image_url", "image_url": {"url": url}}]}],
        temperature=0.001, max_tokens=80)
    first, _, reason = resp.choices[0].message.content.strip().partition("\n")
    first = first.upper()
    label = "not_flood" if "NOT" in first else "flood" if "FLOOD" in first else "uncertain"
    return {"image_id": row["image_id"], "qwen_label": label, "qwen_reason": reason.strip()}

def run(model, rows, out_csv, workers=8):
    out = Path(out_csv)
    done = pd.read_csv(out, dtype=str, keep_default_na=False) if out.exists() else pd.DataFrame()
    have = set(done["image_id"]) if len(done) else set()
    todo = [r for r in rows if r["image_id"] not in have]
    results = done.to_dict("records")
    with ThreadPoolExecutor(workers) as ex:
        for n, res in enumerate(ex.map(lambda r: ask(model, r), todo), 1):
            results.append(res)
            if n % 50 == 0 or n == len(todo):
                pd.DataFrame(results).to_csv(out, index=False)
                print(f"{model}: {n}/{len(todo)}", flush=True)
    return pd.DataFrame(results)

if __name__ == "__main__":
    model, which, out_csv = sys.argv[1], sys.argv[2], sys.argv[3]
    md = pd.read_csv(DATA_DIR / "image_metadata.csv", dtype=str, keep_default_na=False)
    rows = md.head(100) if which == "first100" else md.iloc[100:] if which == "rest" else md
    run(model, rows.to_dict("records"), out_csv)
