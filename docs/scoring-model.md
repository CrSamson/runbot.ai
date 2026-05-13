# Scoring Model

Every weather hour is scored from 0 to 100. Four factors deduct points: temperature drift from the run-type's ideal, wind, precipitation probability, and weather codes. Each window's score is the average across the hours it spans.

For interactive plots and a scenario builder, open [`scoring-visualizer.html`](scoring-visualizer.html) in your browser.

## Temperature — asymmetric sweet-spot

Each run type carries three temperature parameters:

- `feelsIdeal` — the research-aligned best temperature for this run type (7°C for Long Runs, 10°C for Easy, etc.)
- `feelsMin` — the cold edge where the run starts being penalized hard
- `feelsMax` — the warm edge, same idea

The cold-to-ideal and ideal-to-warm distances are usually **asymmetric**. For an Easy run with `feelsMin: 4, feelsMax: 18, feelsIdeal: 10`, the cold side has 6°C of room and the warm side has 8°C. This is intentional — heat-acclimatized runners cope with warmth better than the strict midpoint suggests, while cold below the ideal degrades performance more sharply.

The penalty curve has three zones:

1. **Dead-zone (no penalty)**: 20% of the side range either side of `feelsIdeal`. For Easy: 8.4°C to 11.6°C scores zero on temperature.
2. **Gradient zone (inside the band)**: penalty grows linearly to 12 at the band edge.
3. **Outside-band zone**: penalty continues from 12 at a steeper slope. Cold side: 4 points/°C. Warm side: 5 points/°C (or 7 for long/hard sessions where heat compounds).

```
penalty(feels) =
  if |feels - ideal| ≤ sideRange × 0.2:    0
  if |feels - ideal| ≤ sideRange:           overshoot × 12
  if feels < feelsMin:                      12 + (feelsMin - feels) × 4
  if feels > feelsMax:                      12 + (feels - feelsMax) × heatMult
```

The `+ 12` constants ensure continuity at band edges — no discontinuity where the gradient ends and the harsh regime begins.

## Wind — two-regime linear

```
penalty(wind) =
  if wind ≤ 8 kph:    0
  if wind ≤ 25 kph:   (wind - 8) × 1.0
  if wind > 25 kph:   17 + (wind - 25) × 1.5
```

The `17` is `(25 - 8) × 1.0`, where the soft regime ends. Without it, a 26 kph wind would score better than a 24 kph wind — an unintended discontinuity.

## Precipitation — same shape

```
penalty(precip) =
  if precip ≤ 15%:    0
  if precip ≤ 40%:    (precip - 15) × 0.8
  if precip > 40%:    20 + (precip - 40) × 0.8
```

The `20` is `(40 - 15) × 0.8`. Same continuity story.

## Weather code — discrete categories

WMO weather codes from Open-Meteo map to category penalties:

| Code | Condition | Penalty |
|---|---|---|
| 0–3 | Clear / cloudy | 0 |
| 45, 48 | Fog | 5 |
| 51–55 | Drizzle | 15 |
| 56–57 | Freezing drizzle | 25 |
| 61–65 | Rain | 30 |
| 66–67 | Freezing rain | 45 |
| 71–77 | Snow | 35 |
| 80–82 | Rain showers | 30 |
| 85–86 | Snow showers | 40 |
| 95+ | Thunderstorm | 100 |

This catches situations where precipitation probability is moderate but the *forecasted condition* is already drizzle or rain — the code fires the penalty even if probability is low.

## Run-type rules

Defaults shipped in `TYPE_RULES`. Tweak in `Find Optimal Running Window` as needed.

| Type | feelsMin | feelsMax | feelsIdeal | bufferMin |
|---|---|---|---|---|
| Easy | 4 | 18 | 10 | 15 |
| Long | 0 | 14 | 7 | 25 |
| Tempo | 3 | 16 | 9 | 20 |
| Interval | 3 | 16 | 9 | 25 |
| Time Trial | 2 | 14 | 7 | 30 |
| Rolling 400s | 3 | 16 | 9 | 25 |
| Fartlek | 3 | 16 | 9 | 20 |
| Hill Repeats | 2 | 14 | 7 | 25 |
| Progression | 3 | 15 | 8 | 20 |
| Strength | 4 | 17 | 10 | 20 |

`bufferMin` is added to the run's stated duration when blocking out a calendar slot — accounts for changing, warm-up, post-run, etc. Long/hard sessions get bigger buffers (25–30 min); easy sessions get less (15 min).

## Score interpretation

| Score | Meaning |
|---|---|
| 95–100 | Prime window — go now |
| 85–94 | Excellent, minor compromise |
| 70–84 | Solid, with noticeable factor (look at worst-factor label) |
| 60–69 | Acceptable but suboptimal |
| 40–59 | Marginal — consider rescheduling |
| < 40 | Skip if you can |

The **worst-factor label** under each score names the single deduction that cost the most points. Two windows with the same score can feel very different — "wind −6 (14 kph)" and "temp −6 (feels 16.5°C)" are both 94 but they're different problems.
