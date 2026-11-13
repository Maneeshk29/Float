# Float

**Know what is coming, what is failing, where you can go, and what to do next.**

Float is a map-first flood safety app for Houston and Harris County. It puts official warnings,
live river gauges, rainfall forecasts, FEMA flood zones and nearby essentials on one screen, next to an
experimental AI flood-risk timeline trained on 1,204 labeled Texas flood images. Built for the UTSA Social
Impact AI Datathon on the Dell Pro Max GB10.

Every piece of information is labeled with where it came from and how fresh it is:

| Badge | Meaning | Example |
|---|---|---|
| **OFFICIAL** | Government warning | NWS Flash Flood Warning |
| **VERIFIED LIVE** | Live agency measurement | USGS gauge, read 7 min ago |
| **FORECAST** | Weather-model data | Open-Meteo hourly rainfall |
| **EXPERIMENTAL AI** | Float prediction | 78% flood risk in 6 h |
| **REFERENCE / HISTORICAL** | Static maps and past events | FEMA zone, OpenStreetMap, Harvey imagery |

## Run it

```sh
git clone https://github.com/Maneeshk29/Float.git
cd Float
bash run.sh                       # first run installs packages into .venv (a few minutes)
```

Open **http://localhost:8080**. Needs Python 3.11+ and an internet connection for the live feeds.

To turn on the Qwen vision model on the GB10 (photo descriptions):

```sh
GB10_API_KEY=your-key bash run.sh              # server defaults to http://10.246.100.230/v1
GB10_URL=http://HOST/v1 GB10_API_KEY=... bash run.sh
```

Without the key everything else still works; the header shows "GB10 off". Other settings:
`PORT` (default 8080), `HOST` (default 127.0.0.1; use 0.0.0.0 to share on your network), `GB10_MODEL`,
`ALERT_CHECK_HOURS` (default 3), `FLOAT_STATE_DIR` (where alerts and shelter matches are stored; default `state/`).

## What it does

One tab is visible at a time. A **Before / During / After** switch above the tabs changes what every tab
shows. Float picks **During** automatically when there is an NWS flood alert or high risk; tap a phase to
override. Links can open a tab and phase directly, e.g. `/#shelter/during`.

| Tab | Before | During | After |
|---|---|---|---|
| **Home** | Risk now, 7-day bars, "Get ready" actions, past floods nearby | "Stay safe" actions, official alert banner | "Can I return?" checks, "Recover" actions |
| **Outlook** | 7-day daily risk first, then next 24 h | Next 24 h first | Next 24 h first |
| **Alerts** | Turn on alerts for your place, your places, inbox | same | same |
| **Shelter** | Plan where you'd go | Need shelter now? | Place to stay |
| **Guides** | Kit, plan, protect home, know your risk | Evacuate, water and roads, power and gas | Return, clean up, claims, help |
| **Recovery** | Photograph your home now | Safety first | Document damage + FEMA/NFIP help |
| **Map** | Past floods, live gauges, hospitals, shelter hosts, FEMA zones | same | same |
| **Manager** | Areas ranked by flooding, vulnerability and hospital access | same | same |
| **About** | Data labels, model results | same | same |

### Week-ahead flood alerts

- Anyone can turn on alerts for a place and pick a level ("High risk" or "Moderate or higher").
- Every `ALERT_CHECK_HOURS`, the server re-runs the 7-day outlook for each place (rain forecast 8 days
  out) and sends one alert for the earliest day that reaches the level, e.g.
  **"VERY HIGH flood risk in 5 days · Wed Nov 18 · 95% · 180 mm rain forecast"**.
- NWS flood, hurricane and storm-surge alerts for the place are passed on, marked **OFFICIAL**.
- Alerts show in the Alerts inbox (with a count on the tab) and as browser pop-ups while Float is open.
- No duplicates: each alert is sent once.

### Shelter matching

- **Offer a place:** area name, spots, pets ok, wheelchair access, dates, contact. Others see only an
  area about 1 km wide, never the exact location or contact.
- **Find a host:** hosts within 80 km with enough spots, filtered by pets and wheelchair access, nearest
  first. "Ask to stay" sends a request.
- **My matches:** hosts accept or decline requests. Contacts are shared with both sides only after the host
  accepts. Spots are counted so a place can't be overbooked.
- Official shelters (Red Cross, 2-1-1, FEMA housing) are always shown first. Hosts are not vetted, and the
  app says so.
- There are no accounts: each offer, request or alert gets a secret token kept in that browser.

### Everything else

- Live NWS alerts, USGS gauges, Open-Meteo rain and FEMA zones, each labeled with its source and age.
- Damage photos: fingerprinted (SHA-256), time-stamped, classified by the Float image model and described
  by Qwen on the GB10; printable claim packet.
- Offline: shows the last update with an "OFFLINE" banner. Large-text and high-contrast modes.

## The models

### 1. Flood-risk timeline (`models/risk_model.joblib`)

Two layers, following the research brief:

- **Trained model:** gradient-boosted trees trained on 1,194 labeled sites (flood / not flood). Inputs are
  only things Float can also fetch live for any address: rainfall over the previous 1, 3 and 7 days,
  ground elevation, and FEMA Special Flood Hazard Area status. Monotonic constraints mean more rain can
  only raise the risk.
- **Rainfall rule:** a simple, uncalibrated rule on 6-hour, 24-hour and 3-day rain. The training data has
  almost no storms between "dry" and "Hurricane Harvey", so the trained model under-rates moderate
  storms. The app shows the higher of the two layers and displays both numbers.

Validation is event-based, as the brief requires; we never split one storm randomly between training and
testing.

| Test (trained model alone) | PR-AUC | Recall | Precision | False-alarm rate |
|---|---|---|---|---|
| New areas: leave one locality out | 0.93 | 0.90 | 0.92 | 0.08 |
| New storm: train Harvey 2017, test Hill Country 2025 | 0.55 | 0.60 | 0.46 | 0.62 |
| 100 hand-labeled images | 1.00 | 1.00 | 1.00 | 0.00 |

**Read these carefully:**
- **The 100 hand labels are an easy test.** Every dry photo was taken on a day with no rain.
- **The storm test is weak, and that's a data problem.** The Hill Country floods came from rain upstream;
  gauges at the photo sites recorded almost none. Local rainfall can't predict that kind of flood.
- **Treat every risk number as experimental.**

### 2. Aerial-image classifier (`models/image_model.pt`)

ResNet-18 (ImageNet) fine-tuned on the 320 px thumbnails in `static/thumbs/`. Tested on the 100
hand-labeled images it never saw: **97% accuracy, 47 of 50 floods caught, 0 of 50 false alarms.**

Caveat: in that test set every NOAA image is a flood, so it cannot fully rule out the model having learned
"NOAA camera = flood". It is trained on aerial imagery, so the app also asks Qwen to describe phone photos.

### 3. Qwen3-VL-8B on the GB10

Labeled the 1,104 images not labeled by hand (`scripts/qwen_label.py`). It agreed with the hand labels 94%
of the time, with no false alarms and 6 of 50 floods missed. In the app it describes recovery photos and
dataset images.

## Data

| File | Contents |
|---|---|
| `labels/flood_labels.csv` | Label for each of the 1,204 images, who labeled it, and Qwen's answer and reason |
| `labels/human_labels_first100.csv` | The 100 hand labels |
| `data/sites.csv` | Per-image location, date, rainfall, elevation, FEMA zone and county statistics |
| `data/essentials.json` | OpenStreetMap hospitals, grocery and fuel for Greater Houston (snapshot; locations only) |
| `static/thumbs/` | 320 px thumbnails of all 1,204 images |

Images: [`jennifer-fowler/UTSA-flood-images`](https://huggingface.co/datasets/jennifer-fowler/UTSA-flood-images)
(USDA NAIP 2016 baselines; NOAA NGS Hurricane Harvey 2017 response imagery; 2025 Hill Country flood).

Live sources, all queried at request time:
- NWS alerts (api.weather.gov)
- USGS instantaneous gauge heights (waterservices.usgs.gov)
- Open-Meteo hourly rainfall and elevation
- FEMA National Flood Hazard Layer
- OpenStreetMap Nominatim address search
- FEMA flood-zone map tiles

Map data © OpenStreetMap contributors (ODbL).

## Rebuild everything

```sh
# 1. labels (needs the dataset in flood_data/ and the GB10)
export GB10_API_KEY=...
python scripts/qwen_label.py qwen3-vl-8b-instruct rest out.csv
# 2. site table and essentials snapshot
python training/build_sites.py flood_data/image_metadata.csv
python training/build_essentials.py
# 3. models
python training/train_risk_model.py
python training/train_image_model.py
```

## Project layout

```
floatapp/server.py     web server and API
floatapp/live.py       NWS, USGS, Open-Meteo, FEMA, geocoding (with provenance on every result)
floatapp/models.py     risk timeline, 7-day outlook, image classifier, Qwen on the GB10
floatapp/community.py  week-ahead alerts and shelter matching (stored in state/)
static/               front end (index.html, app.js, style.css, Leaflet, thumbnails)
training/             scripts that build the data files and train the models
models/               trained models and their validation metrics
```

## Honest limits

- **Not an official warning system.** Always follow the NWS and local officials.
- **No routing yet.** The research brief's "lower-risk route" feature isn't built.
- **No live status feeds connected:** shelters, power outages, hospital capacity, grocery stock and fuel.
  The app says so instead of guessing.
- **Coarse inputs:** rainfall comes from weather-model grids. FEMA zones are regulatory maps, not current
  flooding. A gauge reading isn't street-level water depth.
- **County-wide vulnerability:** these figures are county estimates, not neighborhood ones. They're used
  to direct extra help, never to deny it.
- **Week-ahead alerts are only as good as the rain forecast.** Confidence drops after 2 days; the
  Outlook tab says so.
- **Alerts reach people only in the app and as browser pop-ups while Float is open.** No SMS, email or
  phone push yet.
- **Shelter hosts are not vetted.** Official shelters are listed first.
- **Shelter and alert records live on the Float server** in `state/`. Back up or clear that folder as needed;
  there are no accounts.
