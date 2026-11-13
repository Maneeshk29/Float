"""Train the Flood IQ experimental flood-risk model on the labeled sites.

Target: does the place show flooding (label from labels/flood_labels.csv)?
Features: only inputs Flood IQ can also fetch live for any address, so the same model drives the
NOW -> 24 h risk timeline: rainfall over the previous 1, 3 and 7 days, ground elevation and whether the
point is inside a FEMA Special Flood Hazard Area.

Validation follows the event-based rules in the research brief: never split one storm across train
and test at random. We report (1) train on Hurricane Harvey, test on the 2025 Hill Country flood,
(2) leave-one-area-out across localities, and (3) test on the 100 hand-labeled images.

Usage:  python training/train_risk_model.py
"""
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import average_precision_score, brier_score_loss, precision_score, recall_score

ROOT = Path(__file__).resolve().parents[1]
FEATURES = ["rain_1d_mm", "rain_3d_mm", "rain_7d_mm", "elevation_m", "fema_sfha"]
# More rain can only raise the risk; being inside a FEMA flood zone can only raise it.
MONOTONIC = [1, 1, 1, 0, 1]


def make_model():
    return HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_depth=3, min_samples_leaf=20,
                                          l2_regularization=1.0, monotonic_cst=MONOTONIC, random_state=0)


def baseline_rule(X):
    """Deterministic layer: risk from 3-day rainfall alone (50 mm -> low, 150 mm -> high)."""
    return np.clip((X["rain_3d_mm"].fillna(0) - 50) / 100, 0, 1)


def scores(y, p):
    pred = p >= 0.5
    out = {"n": int(len(y)), "floods": int(y.sum())}
    if 0 < y.sum() < len(y):
        out["pr_auc"] = round(float(average_precision_score(y, p)), 3)
    out.update({"recall": round(float(recall_score(y, pred, zero_division=0)), 3),
                "precision": round(float(precision_score(y, pred, zero_division=0)), 3),
                "false_positive_rate": round(float((pred & (y == 0)).sum() / max((y == 0).sum(), 1)), 3),
                "brier": round(float(brier_score_loss(y, p)), 3)})
    return out


def evaluate(train, test):
    model = make_model().fit(train[FEATURES], train["y"])
    return {"model": scores(test["y"], model.predict_proba(test[FEATURES])[:, 1]),
            "rule_baseline": scores(test["y"], baseline_rule(test[FEATURES]))}


def main():
    sites = pd.read_csv(ROOT / "data" / "sites.csv")
    data = sites[sites["label"].isin(["flood", "not_flood"])].copy()
    data["y"] = (data["label"] == "flood").astype(int)

    report = {"features": FEATURES, "training_rows": int(len(data))}
    harvey = data["event_id"] == "harvey_2017"
    report["storm_holdout"] = {"train": "Hurricane Harvey 2017", "test": "Hill Country 2025",
                               **evaluate(data[harvey], data[~harvey])}

    folds = []
    for area, test in data.groupby("locality"):
        model = make_model().fit(data.loc[data["locality"] != area, FEATURES], data.loc[data["locality"] != area, "y"])
        folds.append(pd.DataFrame({"y": test["y"], "p": model.predict_proba(test[FEATURES])[:, 1]}))
    pooled = pd.concat(folds)
    report["area_holdout"] = {"method": "leave one locality out, pooled",
                              "model": scores(pooled["y"], pooled["p"])}

    human = data["labeled_by"] == "human"
    report["human_labeled_test"] = {"train": "model-labeled sites", "test": "100 hand-labeled sites",
                                    **evaluate(data[~human], data[human])}

    final = make_model().fit(data[FEATURES], data["y"])
    (ROOT / "models").mkdir(exist_ok=True)
    joblib.dump({"model": final, "features": FEATURES, "version": "floodiq_risk_hgb_v1"},
                ROOT / "models" / "risk_model.joblib")
    (ROOT / "models" / "risk_model_metrics.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
