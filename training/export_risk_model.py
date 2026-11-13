"""Export the trained risk model (scikit-learn HistGradientBoosting) to plain JSON trees.

The app evaluates the JSON with a few lines of Python, so the deployed server does not need
scikit-learn or SciPy (they push serverless bundles over Vercel's size limit).

Usage:  python training/export_risk_model.py      (after train_risk_model.py)
"""
import json
import sys
from pathlib import Path

import joblib
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    bundle = joblib.load(ROOT / "models" / "risk_model.joblib")
    model = bundle["model"]
    trees = []
    for predictors in model._predictors:
        (pred,) = predictors                       # binary classification: one tree per iteration
        nodes = pred.nodes
        trees.append({
            "feature": nodes["feature_idx"].tolist(), "threshold": nodes["num_threshold"].tolist(),
            "missing_left": nodes["missing_go_to_left"].astype(int).tolist(),
            "left": nodes["left"].tolist(), "right": nodes["right"].tolist(),
            "leaf": nodes["is_leaf"].astype(int).tolist(), "value": nodes["value"].tolist(),
        })
    out = {"version": bundle["version"], "features": bundle["features"],
           "baseline": float(np.ravel(model._baseline_prediction)[0]), "trees": trees}
    (ROOT / "models" / "risk_model.json").write_text(json.dumps(out, separators=(",", ":")))

    # Check the JSON evaluator reproduces scikit-learn exactly
    from floatapp.models import predict_risk
    rng = np.random.default_rng(0)
    X = np.column_stack([rng.uniform(0, 300, 2000), rng.uniform(0, 800, 2000), rng.uniform(0, 1200, 2000),
                         rng.uniform(0, 600, 2000), rng.integers(0, 2, 2000).astype(float)])
    X[rng.random(X.shape) < 0.05] = np.nan
    ours = predict_risk(out, X.tolist())
    theirs = model.predict_proba(X)[:, 1]
    diff = float(np.max(np.abs(np.array(ours) - theirs)))
    print(f"wrote models/risk_model.json ({len(trees)} trees); max difference vs scikit-learn: {diff:.2e}")
    assert diff < 1e-9


if __name__ == "__main__":
    main()
