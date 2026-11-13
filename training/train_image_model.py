"""Train the Float aerial-image classifier (flood / not flood) on the labeled thumbnails.

Fine-tunes an ImageNet ResNet-18 on static/thumbs/*.jpg using labels/flood_labels.csv.
Test set: the 100 hand-labeled images (never seen in training). We also report accuracy on NOAA
images only, because a model can otherwise score well just by telling the 2016 USDA camera apart
from the 2017 NOAA camera.

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=6)
    args = ap.parse_args()
    random.seed(0); np.random.seed(0); torch.manual_seed(0)
    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    print("device:", device)

    sites = pd.read_csv(ROOT / "data" / "sites.csv")
    data = sites[sites["label"].isin(["flood", "not_flood"])].copy()
    data["y"] = (data["label"] == "flood").astype(int)
    human = data["labeled_by"] == "human"

    print("Training on model-labeled images, testing on the 100 hand-labeled images")
    model = train(data[~human], args.epochs, device)
    test = data[human].reset_index(drop=True)
    p = predict(model, test, device)
    noaa = test["source_agency"].str.contains("NOAA").to_numpy()
    report = {"architecture": "ResNet-18 (ImageNet) fine-tuned", "epochs": args.epochs,
              "hand_labeled_test": summary(test, p),
              "hand_labeled_test_noaa_only": summary(test[noaa], p[noaa])}

    print("Training final model on all labeled images")
    final = train(data, args.epochs, device)
    (ROOT / "models").mkdir(exist_ok=True)
    torch.save(final.state_dict(), ROOT / "models" / "image_model.pt")
    report["training_images"] = int(len(data))
    (ROOT / "models" / "image_model_metrics.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
