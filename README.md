# FloodIQ

Flood / not-flood labels for the 1,204 Texas aerial images in
[`jennifer-fowler/UTSA-flood-images`](https://huggingface.co/datasets/jennifer-fowler/UTSA-flood-images)
(Hurricane Harvey response imagery vs. 2016 baselines).

## Labels

`labels/flood_labels.csv`: one row per image.

| column | meaning |
|---|---|
| `label` | `flood`, `not_flood` or `uncertain` (the label to use) |
| `labeled_by` | `human` (first 100 images, labeled by hand) or `qwen3-vl-8b-instruct` (the other 1,104) |
| `qwen_label`, `qwen_reason` | the model's answer and visible clue, for every image (including the human-labeled ones) |
| `image_path`, `source_agency`, `acquisition_date`, `locality`, `image_role` | from the dataset's `image_metadata.csv` |

`labels/human_labels_first100.csv`: the hand labels on their own.

| labeled by | flood | not_flood | uncertain |
|---|---|---|---|
| human | 50 | 50 | 0 |
| qwen3-vl-8b-instruct | 555 | 539 | 10 |

## How the model labels were made

Qwen3-VL-8B-Instruct running on a Dell Pro Max GB10, prompted with the question in
`scripts/qwen_label.py`. On the 100 hand-labeled images it agreed with the human label
94% of the time: no false alarms, 6 of 50 floods missed (mostly shallow water spread across fields).

**Check before trusting:** among the 1,104 model-labeled images, 42 `before` (2016 baseline) photos
are labeled `flood` and 65 `response` photos `not_flood`. Some `response` photos genuinely show no
water, but most `before`-labeled floods are likely false alarms on rivers or ponds.

## Re-running

```sh
pip install openai pandas pillow
export GB10_API_KEY=...        # GB10 key from the organizers
cd scripts && python qwen_label.py qwen3-vl-8b-instruct rest out.csv   # run next to a flood_data/ folder
```
