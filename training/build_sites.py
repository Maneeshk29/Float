"""Build data/sites.csv: one row per labeled image with the features Flood IQ uses.

Usage:  python training/build_sites.py path/to/flood_data/image_metadata.csv
"""
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]

COLUMNS = {
    "image_id": "image_id",
    "event_id": "event_id",
    "event_name": "event_name",
    "locality": "locality",
    "county_name": "county",
    "latitude": "lat",
    "longitude": "lon",
    "acquisition_date": "date",
    "image_role": "image_role",
    "source_agency": "source_agency",
    "dependence_group": "group",
    "preceding_1d_precipitation_mm": "rain_1d_mm",
    "preceding_3d_precipitation_mm": "rain_3d_mm",
    "preceding_7d_precipitation_mm": "rain_7d_mm",
    "elevation_m": "elevation_m",
    "fema_sfha_tf": "fema_sfha",
    "fema_flood_zones": "fema_zones",
    "usgs_gage_height_station_name": "gauge_station",
    "county_poverty_percent": "poverty_pct",
    "county_no_vehicle_households_percent": "no_vehicle_pct",
    "county_age65plus_percent": "age65_pct",
    "county_disability_percent": "disability_pct",
    "county_population": "county_population",
    "attribution": "attribution",
}


def main(metadata_csv):
    md = pd.read_csv(metadata_csv, dtype=str, keep_default_na=False)
    labels = pd.read_csv(ROOT / "labels" / "flood_labels.csv", dtype=str, keep_default_na=False)
    sites = md[list(COLUMNS)].rename(columns=COLUMNS).merge(
        labels[["image_id", "label", "labeled_by", "qwen_reason"]], on="image_id", how="inner")
    sites["fema_sfha"] = sites["fema_sfha"].map({"T": 1, "F": 0})
    assert len(sites) == len(labels), "every labeled image must have metadata"
    out = ROOT / "data" / "sites.csv"
    sites.to_csv(out, index=False)
    print(f"wrote {out} ({len(sites)} sites)")
    print(sites["label"].value_counts().to_string())


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "flood_data/image_metadata.csv")
