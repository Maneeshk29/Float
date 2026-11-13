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

**1. Asks where you are.** On first open, Float asks for your location ("Use my location", or type an address),
then why you're here: *I need a place to stay · I need a ride out · I need other help · I can host people ·
I can give rides · Just keeping informed*.

**2. Checks your spot** against live and historical sources:

| What | Source |
|---|---|
| Official warnings | National Weather Service |
| 8-day weather | Open-Meteo |
| Flood history | OpenFEMA flood-insurance claims for your ZIP, federal flood disasters for your county, FEMA flood zone, labeled Harvey imagery nearby |
| Local flood news | Google News (city, falling back to county) |
| Flood prediction | Float's risk model on the 8-day rain forecast |

**3. Gives one verdict** for the next 7 days: **No flooding expected**, **Flooding possible** or
**Heavy flooding likely**, with the peak day and the reasons. An NWS flood/hurricane warning, a HIGH forecast,
or a MODERATE forecast in a place with a high flood history all count as heavy.

**4. Connects people to help.** When flooding is heavy, or the profile says *I need a place to stay / a ride /
other help*, Home shows **Get to safety**:
- 911, 2-1-1 (official shelters and Texas STEAR evacuation rides), Red Cross, 3-1-1;
- nearby hosts and volunteer drivers that fit the household (people, pets, wheelchair), each one tap to
  request using the profile's name and phone;
- nearest public shelters, plus the Red Cross live list.

Hosts and drivers accept or decline. Contacts are shared with both sides only after acceptance, and
exact locations are never shown (only a ~1 km area).

**Always available, whatever the risk:** nearest hospitals, pharmacies, grocery stores, fuel and shelters
(list or map, with directions).

### Tabs

| Tab | What's there |
|---|---|
| **Home** | Verdict, Get to safety (when needed), weather strip, tiles: flood history, closest places, news, your plan, guide, alerts |
| **Nearby** | Hospitals · Pharmacies · Grocery · Fuel · Shelters, list or map |
| **Help** | Stay / Ride / Matches: find or offer a place or a ride, accept requests |
| **Alerts** | One switch: warnings up to 7 days ahead for your place; inbox |
| **Guides** | Before / During / After checklists; damage photos for claims |
| **Me** | Profile (role, household, needs, contact) and settings; manager view and About |

The **Before / During / After** switch changes Home and Guides; Float picks *During* automatically when
flooding is likely. Week-ahead alerts re-check every `ALERT_CHECK_HOURS` and send one alert for the earliest
day that reaches the chosen level, plus official NWS flood alerts. Big text, high contrast and offline mode
are built in.

### Tests

```sh
python tests/community_test.py http://localhost:8080     # alerts + shelter/ride API
node tests/ui_flow_test.mjs http://localhost:8080        # full browser flow (needs Chrome, Node 22+)
```
Run them against a server started with `FLOAT_STATE_DIR=/tmp/float_test_state` so test data stays separate.

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
floatapp/community.py  week-ahead alerts, profiles, shelter and ride matching (stored in state/)
floatapp/check.py      place, weather, flood history, news and the impact verdict
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
- **Hosts and drivers are not vetted.** Official shelters and 2-1-1 are always listed first.
- **Flood history uses ZIP and county records.** A ZIP with many claims can still have dry streets.
- **Places list covers Greater Houston.** Elsewhere, Nearby says so.
- **Shelter and alert records live on the Float server** in `state/`. Back up or clear that folder as needed;
  there are no accounts.
