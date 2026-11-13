"""Train the Float aerial-image classifier (flood / not flood) on the labeled thumbnails.

Fine-tunes an ImageNet ResNet-18 on static/thumbs/*.jpg.

Label sources (kept in separate files, combined here):
  1. data/sites.csv                        - original labels: 100 by hand, the rest by Qwen3-VL-8B
  2. labels/human_labels_second_pass.csv   - 306 images reviewed by hand in a second pass
A human label always beats a Qwen label. If the two human passes disagree on an image, it is
treated as uncertain and left out of both training and testing.

Test set: every hand-labeled image (never seen in training). We also report the original 100-image
test, NOAA images only (a model can otherwise score well just by telling the 2016 USDA camera apart
from the 2017 NOAA camera), and the 2025 Hill Country images.

Usage:  python training/train_image_model.py [--epochs 6]
"""
import argparse
import json
import random
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from torchvision import models, transforms

ROOT = Path(__file__).resolve().parents[1]
THUMBS = ROOT / "static" / "thumbs"
IMAGE_SIZE = 224
NORM = transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])
TRAIN_TF = transforms.Compose([transforms.RandomResizedCrop(IMAGE_SIZE, scale=(0.6, 1.0)),
                               transforms.RandomHorizontalFlip(), transforms.RandomVerticalFlip(),
                               transforms.ColorJitter(0.2, 0.2, 0.2), transforms.ToTensor(), NORM])
EVAL_TF = transforms.Compose([transforms.Resize((IMAGE_SIZE, IMAGE_SIZE)), transforms.ToTensor(), NORM])


class Thumbs(Dataset):
    def __init__(self, frame, tf):
        self.rows, self.tf = frame.to_dict("records"), tf

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        r = self.rows[i]
        return self.tf(Image.open(THUMBS / f"{r['image_id']}.jpg").convert("RGB")), r["y"]


def build_model():
    model = models.resnet18(weights=models.ResNet18_Weights.IMAGENET1K_V1)
    model.fc = nn.Linear(model.fc.in_features, 2)
    return model


def train(frame, epochs, device):
    model = build_model().to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, epochs)
    loader = DataLoader(Thumbs(frame, TRAIN_TF), batch_size=32, shuffle=True, num_workers=0)
    for epoch in range(epochs):
        model.train()
        total = 0.0
        for x, y in loader:
            x, y = x.to(device), y.to(device)
            loss = nn.functional.cross_entropy(model(x), y)
            opt.zero_grad(); loss.backward(); opt.step()
            total += loss.item() * len(y)
        sched.step()
        print(f"  epoch {epoch + 1}/{epochs}  loss {total / len(frame):.4f}")
    return model


@torch.no_grad()
def predict(model, frame, device):
    model.eval()
    out = []
    for x, _ in DataLoader(Thumbs(frame, EVAL_TF), batch_size=64, num_workers=0):
        out.append(torch.softmax(model(x.to(device)), 1)[:, 1].cpu())
    return torch.cat(out).numpy()


def summary(frame, p):
    pred = (p >= 0.5).astype(int)
    y = frame["y"].to_numpy()
    return {"n": int(len(y)), "accuracy": round(float((pred == y).mean()), 3),
            "floods_caught": f"{int(((pred == 1) & (y == 1)).sum())}/{int(y.sum())}",
            "false_alarms": f"{int(((pred == 1) & (y == 0)).sum())}/{int((y == 0).sum())}"}


def load_labels():
    """Combine the original labels with the second-pass hand labels (human beats Qwen)."""
    sites = pd.read_csv(ROOT / "data" / "sites.csv")
    sites["first_pass_human"] = sites["labeled_by"] == "human"
    sources = {"original (data/sites.csv)": {
        "human": int(sites["first_pass_human"].sum()),
        "qwen3-vl-8b-instruct": int((~sites["first_pass_human"]).sum())}}

    second = ROOT / "labels" / "human_labels_second_pass.csv"
    if not second.exists():
        return sites, sources
    sp = pd.read_csv(second)[["image_id", "label"]].rename(columns={"label": "label_2"})
    data = sites.merge(sp, on="image_id", how="left")
    has2 = data["label_2"].notna()
    conflict = has2 & data["first_pass_human"] & (data["label"] != data["label_2"])
    changed = has2 & ~data["first_pass_human"] & (data["label"] != data["label_2"])
    take2 = has2 & ~data["first_pass_human"]
    data.loc[take2, "label"] = data.loc[take2, "label_2"]
    data.loc[take2, "labeled_by"] = "human_second_pass"
    data.loc[conflict, "label"] = "uncertain"
    sources["second pass (labels/human_labels_second_pass.csv)"] = {
        "images": int(has2.sum()),
        "replaced_qwen_label": int(take2.sum()),
        "qwen_label_corrected": int(changed.sum()),
        "agreed_with_first_human_pass": int((has2 & data["first_pass_human"] & ~conflict).sum()),
        "human_conflicts_dropped": int(conflict.sum())}
    return data.drop(columns="label_2"), sources


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=6)
    args = ap.parse_args()
    random.seed(0); np.random.seed(0); torch.manual_seed(0)
    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    print("device:", device)

    data, sources = load_labels()
    data = data[data["label"].isin(["flood", "not_flood"])].copy()
    data["y"] = (data["label"] == "flood").astype(int)
    human = data["labeled_by"] != "qwen3-vl-8b-instruct"

    print(f"Training on {int((~human).sum())} model-labeled images, "
          f"testing on {int(human.sum())} hand-labeled images")
    model = train(data[~human], args.epochs, device)
    test = data[human].reset_index(drop=True)
    p = predict(model, test, device)
    noaa = test["source_agency"].str.contains("NOAA").to_numpy()
    first100 = test["first_pass_human"].to_numpy()
    hill = test["event_id"].astype(str).str.contains("hill", case=False).to_numpy()
    report = {"architecture": "ResNet-18 (ImageNet) fine-tuned", "epochs": args.epochs,
              "label_sources": sources,
              "hand_labeled_test": summary(test, p),
              "hand_labeled_test_original_100": summary(test[first100], p[first100]),
              "hand_labeled_test_noaa_only": summary(test[noaa], p[noaa]),
              "hand_labeled_test_hill_country_2025": summary(test[hill], p[hill])}

    print("Training final model on all labeled images")
    final = train(data, args.epochs, device)
    (ROOT / "models").mkdir(exist_ok=True)
    torch.save(final.state_dict(), ROOT / "models" / "image_model.pt")
    report["training_images"] = int(len(data))
    (ROOT / "models" / "image_model_metrics.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
