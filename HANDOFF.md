# HANDOFF — snowtrace eval suite

This supersedes the premise of the original `evals/` handoff. That document was
written **without a checkout**: field names were reconstructed from usage and
five claims were read off the GitHub web view rather than measured.

The source is now available locally at `analysis/src/snowtrace_analysis/`
(11 modules, 1679 lines) and §1–§4 were verified by reading it.

**Read §8 first.** L0 and L1 have both since run, and L1 produced findings that
matter more than any of claims A–E: the pipeline degrades the footage it then
judges (§8.1), and the camera-stability metric barely responds to camera
movement (§8.2). §1–§4 are kept as the record of what was derived before any
code ran, not as the current state.

---

## 0. Environment

Sections dated 2026-09-04 unless noted. Rows marked ✅ were true at the time and
have since been resolved — kept so the sequence stays legible.

| | state |
|---|---|
| git | ✅ was uninitialised; repo has full history, work committed through `57beb80` |
| `evals/` | ✅ was pasted text only; now on disk, L0 + L1 both run |
| clean clips | 6 known; **1 usable** (`30331562`, trimmed — see §7) |
| ffmpeg / ffprobe | present (`/opt/homebrew/bin`) |
| python | `.venv` py3.12 — mediapipe 0.10.35, opencv-python-headless 4.14, numpy 2.5.2 |
| pose model | `analysis/models/pose_landmarker_lite.task` |

`.gitignore` now excludes `/evals/out/`, `/evals/clips/`, `/.eval-work/` and
`*.mp4|*.mov|*.MOV`. The likeness-rights constraint from §7 of the original
handoff is therefore enforced by the ignore file, not just by convention.

---

## 1. The five claims — all confirmed, one is worse than stated

Verified against `quality.py` and `video.py`. None of these needed a run.

**A. The `turns` check carries no information — CONFIRMED.**
`turn_score = min(100.0, len(turns) / 3.0 * 100.0)` and `len(turns) < 3` appends
a hard failure, which forces `rejected`. So in *every* non-rejected result
`turn_score == 100` exactly. This is a property of the formula, provable
statically; it does not need the L0 sweep to demonstrate it.

**B. Rider size has three inconsistent numbers — CONFIRMED.**
- hard failure at `bbox_height < 0.12`
- score normalized as `min(100, bbox_height / 0.35 * 100)`
- recapture text: "occupies at least 20% of frame height"

Which number becomes canonical is a product decision. L1's `rider_size` ladder
measures where landmarks actually degrade; it does not decide.

**C. The two mechanisms disagree — CONFIRMED, and broader than described.**
The original handoff describes one conflict (readiness ≥ 75 forced to `limited`
by a hard threshold). There are in fact **four** independent limiters that
bypass readiness entirely:

1. `limited_by_capture = blur_score < 50 or stability_score < 50`
2. `camera_mode == "follow"` — unconditional, regardless of every other signal
3. `visibility_limited = len(visible_metrics) < len(candidate_metrics)`
4. the tail branch `if status != "rejected" and not allowed:` → **`rejected`**

(4) is the sharpest instance and was not in the original write-up: a clip can
carry `readiness_score` in the 90s and still be **rejected** outright, because
the allowlist intersection came out empty. The number shown to the rider
explains neither the `limited` nor the `rejected` verdict.

**D. Check weights sum to 110 — CONFIRMED.**
`25 + 20 + 15 + 10 + 10 + 10 + 5 + 5 + 10 = 110`. Harmless (the code divides by
the actual sum) but no weight is readable as a percentage.

**E. The gate judges blur from ~10 frames — CONFIRMED.**
`sample_visual_quality(path, sample_count=10)` reads
`np.linspace(0, frame_count - 1, min(sample_count, frame_count), dtype=int)`
and takes the median. Deterministic, knowable positions. Still the most serious
of the five; no threshold change closes it.

---

## 2. Corrected field names

The original handoff §4 listed these as inferred. Now read from `contracts.py`:

| original claim | actual | consequence |
|---|---|---|
| `QualityCheck.identifier` | **`id`**, plus a `status: Literal["good","medium","blocked"]` field between `weight` and `detail` | `gate_surface.py` does `{c.identifier: c.score ...}` → **AttributeError** |
| `PoseObservation`: `.mean_visibility`, `.bbox` | also `frame_index`, `timestamp_ms`, `landmarks: np.ndarray` | `frame_index` is load-bearing — `_gap_ratio` and `_active_segment_frames` both key off it |
| `RiderTrack.first_timestamp_ms` etc. | **properties, not fields**; `RiderTrack` fields are `track_id`, `observations`, `score` | good news: `asdict` omits them and `_build` does not require them — `fixture.py` is safe here |
| `Turn`: "completely unknown" | `index`, `edge_type`, `start_ms`, `apex_ms`, `end_ms`, `confidence`, `marker_source` | resolved |
| `rider_candidates(...)` → items with `.track_id` | returns **`list[dict[str, object]]`** | `fixture.capture`'s `[c.track_id for c in result.rider_candidates]` → **TypeError** |
| `QualityGateResult` | matches exactly; `readiness_score` is `int` | ok |
| `metric_landmark_reliability(track, stance)` | matches; landmark visibility is `observation.landmarks[:, 3]` | ok |

`fixture.py`'s generic `_coerce` handles `np.ndarray`, the 4-tuple `bbox`, and
`list[PoseObservation]` correctly as written. Do not start hard-coding fields.

---

## 3. Phase 0 blockers (in order)

1. `evals/` does not exist — write the three files to disk first.
2. `gate_surface.py`: `c.identifier` → `c.id`.
3. `fixture.py` `capture()`: `result.rider_candidates` items are dicts →
   `[c["track_id"] for c in ...]`.
4. `degrade.py` sampling indices are computed with the wrong rounding (§4.1).

---

## 4. Two intent-level problems — flagged, not silently fixed

These change what the eval *means*, not just whether it runs. Per the original
handoff's instruction, they are surfaced rather than patched over.

### 4.1 `sampling_evasion` cannot construct its adversarial case as written

Two separate defects, both fatal to the axis:

**Wrong rounding.** Production truncates (`dtype=int`); `degrade.py` uses
`int(round(i * step))`. For a 600-frame clip:

```
production : [0, 66, 133, 199, 266, 332, 399, 465, 532, 599]
degrade.py : [0, 67, 133, 200, 266, 333, 399, 466, 532, 599]
             4 of 10 positions differ
```

**Wrong coordinate system.** The `enable='not(eq(n,i))'` expression is applied
to the *source* clip, but `sample_visual_quality` reads the *proxy*, which
`create_proxy` has resampled to CFR 30. `degrade.render()` does not pin fps, so
on any non-30fps source the frame indices refer to a different timeline
entirely. `probe_frame_count` compounds this by estimating `duration * 30`
rather than reading the proxy's actual `CAP_PROP_FRAME_COUNT`.

*Proposed fix (not yet applied):* run `create_proxy` once on the clean clip and
use that normalized file as the source for every rung; render variants with
`fps=30` pinned so the pipeline's own proxy step is near-identity; derive
indices with `np.linspace(..., dtype=int)` from the proxy's real frame count.

Consequence if left alone: the axis can report `rejected` (looking like the gate
is fine) or `full` (looking like the finding is confirmed) for reasons unrelated
to sampling. Either way the result is uninterpretable.

### 4.2 `gate_surface.py`'s dead-weight assertion always fails, for the wrong reason

The sweep varies only `blur/stability/exposure` plus `camera_mode/view_angle/
stance`. But `pose_coverage`, `full_body`, `rider_size` and `occlusion` are pure
functions of the track — constant across the entire sweep *by construction*.
`find_dead_weights` will return all four plus `turns`, and the trailing
`assert not find_dead_weights(points)` fails unconditionally, on any fixture,
whether or not a real problem exists.

"Carries no information" has to be scoped to checks whose inputs were actually
swept (`motion_blur`, `stability`, `exposure`, `metric_visibility`). Claim A —
the real finding — is a statement about the formula and belongs in a separate
static assertion, not in the sweep.

Related: `find_mechanism_conflicts` over-counts. `camera_mode == "follow"` makes
half the sweep `limited` for an unrelated reason. Conflicts must be attributed
to a cause before being counted.

### 4.3 Cheap win (no intent change)

`degrade.evaluate()` re-runs `sample_visual_quality` and
`estimate_camera_stability` on the proxy after `analyze_video` has already
computed both. They are the two most expensive calls in the loop. All three
scores are already on `result.quality.checks`, keyed by id `motion_blur`,
`stability`, `exposure`. Reading them there halves the runtime and removes a
second derivation that can drift from the first.

---

## 5. Clip inventory

Both clips live outside the repo (WeChat container) and must stay there.

| clip | duration | frames | resolution | fps | usable? |
|---|---|---|---|---|---|
| `5288e320…mp4` | **2.53 s** | 76 | 720x1280 portrait | 30 | **no** |
| `70e23e90…mp4` | 3.97 s | 119 | 720x1280 portrait | 30 | marginal |

**The short clip cannot enter the pipeline at all.** `AnalysisPipeline.
analyze_video` raises `ValueError("Source clip must be between 3 and 30
seconds.")` before any analysis happens. It is unusable for both fixture
capture and L1.

That leaves **one** clip. Two knock-on effects:

- The original handoff assumes "fewer than ten clips, run all of them." One
  clip is not a calibration set. L1 flip points from a single 4-second portrait
  clip are a data point, not a curve — record them as such, do not propose
  constant changes off one clip.
- `turn_count_ladder` computes `d = max(3.05, duration * frac)`. At 3.97 s, the
  fracs 0.75 / 0.5 / 0.35 / 0.2 **all clamp to 3.05** — four identical renders
  filed under four different severities. The axis is inert on this clip.

There is also a real chance the one usable clip does not itself pass the gate:
3.97 s is short for three connected S-turns, and `len(turns) < 3` is a hard
reject. If it fails, there is no known-good clip and L1 is blocked on
acquiring footage, not on code.

---

## 6. Non-goals (unchanged)

Do not loosen a threshold to make a test pass; do not refactor comparison or
coaching logic; do not train or swap the pose model; do not commit rider video;
do not add a dependency or an eval framework; L0 must never need video,
MediaPipe or ffmpeg.

---

## 7. Phase 0 / Phase 1 results (2026-09-04)

### Clip inventory, revised

Three more clips arrived. Corrected picture:

| clip | duration | candidates | turns | verdict |
|---|---|---|---|---|
| `5288e320…` | 2.53 s | — | — | unusable, under the 3 s pipeline floor |
| `70e23e90…` | 3.97 s | 2, ambiguous | — | marginal |
| `6634c1c3…` | 22.53 s | 4, ambiguous; coverage 0.9–15%, bbox 0.03–0.16 | — | wide shot, riders too small |
| `5272aec6…` | 10.10 s | **0** | — | no track survives the 3-observation filter |
| `372bdb2f…` | 11.83 s | 1, unambiguous, score 0.54, bbox 0.283 | 2 | first fixture; below the turn floor |
| `30331562…` | **56.34 s** | 4 per window, ambiguous | **8** | **the fixture**, after trimming |

`30331562…` is 56 s — over the 30 s pipeline ceiling, so it cannot be analyzed
whole. Unlike the 2.53 s clip, that is fixable: trimming is legitimate where
padding is not. Two 27 s windows were tested; the second one carries a track
with the best coverage seen anywhere in this footage set.

**Current fixture** — `evals/fixtures/track_clean.json`, 1431 KB:

```
source 303315627051b758165eb4f7cfa80c90.mp4 (56.34s, 568x320)
window ffmpeg -ss 28 -t 27
rider  track_id 3
```

347 observations, 8 turns, coverage 0.43, bbox height 0.178, readiness 80,
**no hard failures**, gate `limited`. It is the first clip in the set to clear
`MIN_TURNS`, and the first to produce a non-degenerate decision surface with
production thresholds intact.

Caveat worth carrying: the source is 568x320 landscape, which `create_proxy`
**upscales** to ~1278x720. Landmark quality is bounded by the original 320-line
source, not by the proxy's dimensions. Every number measured off this fixture
inherits that.

`fixture.py` now records `provenance` and `track_id` in the fixture meta, and
`gate_surface` prints it in the report header. Footage can never be committed,
so that line is the only route back to it; a fixture without one is
reproducible by its author and nobody else.

### Claim C.2 confirmed on real data

The first capture of `372bdb2f` returned **`readiness_score: 91` with status
`rejected`** (`hard_failures: ["insufficient_turns"]`). The disagreement
predicted in §1 from source reading is real, not theoretical: the rider is shown
a 91 next to a rejection. See defect 6 below — the *cause* was initially
reported wrong even though the claim held.

### `MIN_TURNS`: lowered to 1, then restored to 3

`quality.py` now carries a named `MIN_TURNS = 3` constant where a bare literal
used to be. It was briefly set to 1 to get a non-degenerate L0 surface out of
the only usable clip (2 detected turns), then restored the same day by owner
decision. **Current production behaviour is unchanged from before this work.**

The round trip is worth keeping because of what it exposed, and the comment on
the constant records it:

- At `MIN_TURNS = 1`, the reject floor and `turn_score`'s 3.0 normalization
  reference become two different numbers for one concept — structurally the
  same defect as `rider_size` (.12 floor / .35 score reference / 20% message).
  Holding both at 3 keeps them aligned. **Move one and you must decide about
  the other.**
- **Claim A is a function of that gap, not a fixed truth.** `turn_score`
  discriminates only inside the window `[MIN_TURNS, 3)`. At 3 the window is
  empty and the check is dead weight (claim A confirmed); at 1 the window is
  `{1, 2}` and the check carries real information (claim A refuted).
  `gate_surface` computes this from `quality.MIN_TURNS` rather than a literal,
  so the claim re-evaluates itself instead of going stale.
- `analysis/tests/` is **45/45 green** at `MIN_TURNS = 3`. While it was 1,
  `test_two_turns_are_not_enough_for_same_edge_pairing` failed
  (`'full' != 'rejected'`); that test was never edited, and restoring the
  floor turned it green on its own — which is the correct way for it to
  recover.

### L0 output

`evals/out/surface.md`. Four runs were made; the fourth is the one that counts.
Recording all of them, because the contrast is itself the finding:

| run | fixture | `MIN_TURNS` | full/limited/rejected | claim A | claim C.1 | claim C.2 |
|---|---|---|---|---|---|---|
| 1 | `372bdb2f`, 2 turns | 1 | 14/86/0 | refuted (window `{1,2}`) | **confirmed** 36.3%, worst 91 | not exercised |
| 2 | `372bdb2f`, 2 turns | 3 | 0/0/**100** | **confirmed** | not exercised | **confirmed**, worst **94** |
| 3 | `30331562`, 8 turns | 3 | 14/86/0 | **confirmed** | **confirmed** 35.2%, worst 87 | not exercised |
| 4 | `30331562`, 8 turns | 3, step 10 | 15/85/0 | **confirmed** | **confirmed** 33.8%, worst 87 | not exercised |

Runs 1 and 2 are historical: run 1 required loosening a production threshold,
run 2 produced a flat surface. **Run 4 is the current committed state** — real
footage, production thresholds untouched, non-degenerate surface, inside the
runtime budget.

Findings that survive every run:

- **Claim A confirmed.** With `MIN_TURNS = 3` the discriminating window
  `[3, 3)` is empty; `turn_score` is a constant 10-point offset on readiness.
- **Claim C.1 confirmed.** A third of the surface (33.8% at step 10, 35.2% at
  step 5 — the estimate is stable under grid resolution) scores readiness ≥ 75
  and is demoted to `limited` by blur or stability alone. Worst case readiness
  87. The number shown to the rider does not explain the verdict.
- **Flip points: blur 50, stability 50, exposure never.** Exposure carries a 5
  weight and no hard threshold, and on every fixture tried it has never moved a
  verdict.
- **`metric_visibility` pinned at 100** across all 12 mode/view/stance
  combinations — now on **two unrelated clips**, which is what the earlier note
  asked for before drawing a conclusion. Not yet proof the weight is dead, but
  it is no longer a single-fixture coincidence. Worth an L1 axis that actually
  attacks landmark visibility.

C.2 is not reachable from the committed fixture: nothing in the sweep rejects.
Its confirmation stands on run 2, which is recorded rather than reproducible.

### Three further defects found while running

4. `gate_surface.py --json` crashed: `Point` is `slots=True` and has no
   `__dict__`. Fixed with `dataclasses.asdict`. Only reachable via `--json`,
   which is why it survived the first read-through.
5. The trailing `assert not find_dead_weights(points)` was **removed, not
   repaired**. Scoping it to swept inputs (§4.2) was necessary but not
   sufficient: it still reddens on a fixture whose landmarks happen to be
   reliable in all six view/stance combinations. A CI gate that fails on a
   fixture property is §4.2's mistake one level down. What belongs there is an
   assertion on claim A's window against `quality.MIN_TURNS`; it is left out
   until a second fixture exists to confirm it is not encoding this clip's
   quirks.
6. **C.2 was being reported with the wrong cause.** The first version asserted
   the high-readiness rejections came from the empty-allowlist tail branch.
   They did not — all 111,132 came from `insufficient_turns`, an upstream hard
   failure. This is exactly the over-counting that `find_mechanism_conflicts`
   was written to avoid, repeated one section further down. `Point` now carries
   `hard_failures` and C.2 is split by route. **The claim survives either way**
   (the rider still sees 94 next to a rejection) but the mechanism named was
   wrong, and a report that misnames a mechanism sends the fix to the wrong
   place.

### Constraint pressure

The original "a stranger runs L0 in under a minute" is **superseded: the budget
is 90 s**, owner decision.

That budget was set against a 69-observation fixture where step 5 measured
82 s. The real fixture has **347 observations, and step 5 took 6 min 30 s** —
`build_quality_gate` recomputes `metric_landmark_reliability` over the entire
track on every one of the 111,132 calls, so cost is O(points × observations)
and the budget broke the moment the footage got good.

**The default step is therefore now 10** (15,972 points, 57 s, inside budget).
The coarser grid costs nothing that matters: it still lands exactly on the 50
flip points, and C.1 moves only from 35.2% to 33.8%. `--step 5` remains
available when a finer surface is worth 6.5 minutes.

Worth knowing before L1: the same O(points × observations) cost is why L0 is
sensitive to fixture length at all. L1 pays it once per rung instead, so it
scales with rung count, not sweep size.

---

---

## 8. Phase 2 / L1 results (2026-09-04)

Full ladder: 34 rungs on the `30331562` fixture window, `evals/out/l1_ladder.md`.
33 usable, 1 invalid, 1 miss. Findings ordered by how much damage they do.

### 8.1 create_proxy destroys the blur signal it is then judged on

**This is the finding the suite was built to produce.** Measured directly:

| | Laplacian variance | `blur_score` | verdict |
|---|---|---|---|
| source, 568x320 | **246.8** | **61.7** | passes the 50 threshold |
| after `create_proxy`, 720x1278 | **21.8** | **5.4** | fails catastrophically |

`create_proxy` scales the short side to 720 **unconditionally** — there is no
guard against upscaling. A 320-wide source is blown up 2.25x, which is pure
interpolation: it invents no detail and flattens the high-frequency content that
Laplacian variance measures. 91% of the signal is gone.

The gate then samples blur *from that proxy* and concludes the footage is
motion-blurred. The rider is told:

> "Use brighter light and avoid digital zoom so the rider stays sharp."

That is advice about their filming, for a defect the pipeline introduced. It is
failure mode (1) — wrong advice — arriving exactly where §1 of this document
predicted it would: upstream, in the gate, nowhere near the coaching logic.

Consequences visible across the whole ladder:

- **Every one of the 34 rungs is capped at `limited`**, because
  `limited_by_capture = blur_score < 50` is true unconditionally on this
  footage. The gate has one usable verdict here, not three.
- The blur axis has **6 points of dynamic range** (6 at sigma 0, 0 at sigma 12).
  A check with no range cannot discriminate, and its 10 weight is a near-constant
  penalty rather than a measurement.

**Proposed, not applied** (§6 — this suite measures):
1. Stop upscaling: clamp the proxy scale so it never exceeds the source's short
   side. This is a one-expression change and it fixes the cause.
2. Or sample blur from the *source* rather than the proxy, so the measurement
   is not taken through a transform the pipeline chose.
3. Either way the 50 threshold needs re-deriving afterwards — every number in
   this ladder shifts.

### 8.2 estimate_camera_stability is nearly blind to camera shake

Injected sinusoidal shake, verified to actually move pixels:

| amplitude | mean frame-to-frame pixel delta | `stability_score` |
|---|---|---|
| 0 | 4.45 | 80.2 |
| 8 | 7.95 | 79.5 |
| 32 | **17.63** | **78.6** |

A 4x increase in real inter-frame motion moves the score 1.6 points out of 100.
The gate's shake axis never flipped a verdict at any amplitude tested.

Likely cause is `np.median(magnitude)` over the Farneback flow field. On a
low-texture snow scene most pixels carry no trackable gradient, so the median is
set by the untextured majority no matter what the camera does. A mean, or a high
percentile, would respond. This is a metric-design question, not a threshold one
— exactly like claim E, no threshold change closes it.

### 8.3 Claim E is untestable on this footage, and the rung that "passed" is a false pass

`sampling_evasion` at sigma 8 returned `rejected`, matching its expectation. The
match is meaningless: `blur_score` was 5 against a clean baseline of 6. The
sharpened frames and the blurred frames are indistinguishable to a metric
already pinned near zero, so the evasion could not have been detected *or*
missed. The rejection came from elsewhere in the gate.

The coordinate-system fix (§4.1) is verified working — the sampler read exactly
the frames the filter sharpened, and no rung was marked INVALID for drift. The
axis is sound; the footage cannot exercise it. **Claim E stays open**, and
testing it needs a source at or above 720 on the short side so `blur_score` has
somewhere to move.

At sigma 16 the rung is INVALID: degradation destroyed rider tracking entirely.

### 8.4 Claim B is moot — the bbox floor never binds

The `rider_size` ladder never reaches the .12 / .35 / 20% disagreement:

| scale | status | note |
|---|---|---|
| 1.0 | `limited` | baseline |
| 0.7 | **`rejected`** | readiness 76, stability 99 — still rejected |
| ≤ 0.5 | `rejected` | all scores 0: the track is gone entirely |

MediaPipe loses the rider long before `bbox_height` approaches 0.12. Which of
the three numbers is canonical is therefore a question with no practical
consequence today — **tracking is the binding constraint, not the threshold.**
Reconciling the three numbers would change nothing until tracking improves.

**Harness artefact to fix before re-running this axis:** the black pad border
introduces a hard edge that inflates Laplacian variance — `blur_score` jumps
from 6 to 45 at k=0.7. The blur column on the rider_size rows is measuring the
border, not the footage.

### 8.5 The one MISS is a harness error, not a gate defect

`turn_count` at frac 0.35 expected `rejected`, got `limited` at readiness 79.
Trimming a 27 s clip to 9.45 s still leaves well over 3 turns. The `expect`
values were written against an assumption of much shorter footage. The real flip
sits between 5.4 s and 9.45 s. **The ladder was wrong, the gate was right** —
recorded rather than quietly re-labelled, since a ladder that adjusts its
expectations to whatever it observes cannot fail.

### 8.6 Exposure acts only through readiness

No hard threshold; it moves the verdict only by dragging the weighted sum under
55. Confirmed at brightness +0.6 (`exposure` 0, readiness 45, `rejected`) while
−0.6 (`exposure` 0, readiness 67) stayed `limited`. This independently confirms
L0's "exposure never flips" from the opposite direction.

### 8.7 create_proxy rejects portrait sources more elongated than 16:9

Found when the ladder crashed, not by looking for it. `create_proxy` scales the
short side to 720 and never constrains the long side; `_validate_proxy` then
rejects a portrait proxy taller than 1280. The boundary is exactly 16:9.

Confirmed on a synthetic 1080x2340 clip — 19.5:9, an ordinary phone aspect
ratio — which raises `VideoError` with a message that never mentions aspect
ratio. The eval footage is 1:1.775, inside the bound by 0.003, which is why
nothing had hit this before.

Same root cause as 8.1: the scale expression has no clamp.

### Status of the claims after L1

| claim | before L1 | after L1 |
|---|---|---|
| A — turns check is dead weight | confirmed (L0) | unchanged |
| B — rider size has three numbers | confirmed by reading | **moot in practice** — tracking binds first (8.4) |
| C — two mechanisms disagree | confirmed (L0) | unchanged |
| D — weights sum to 110 | confirmed | unchanged |
| E — blur judged from ~10 frames | confirmed by reading | **untestable on this footage** (8.3) |
| — | — | **new: 8.1, 8.2, 8.7** |

The three new findings all sit in the same place: the gate measures quality
through transforms the pipeline itself applies, on metrics whose dynamic range
nobody checked against real footage. That is a sharper statement of the original
thesis than any of A–E.

---

## 进度(最后更新 2026-09-04)

- 已完成:
  - **Phase 0**:`evals/{__init__,fixture,gate_surface,degrade}.py` 落盘,§3 四个阻塞点全修
  - **Phase 1 (L0)**:`evals/out/surface.md`。claim A 确认、C.1 确认(33.8%,最差 readiness 87)、D 确认;C.2 在真实数据上确认(readiness 94 仍 rejected)
  - **Phase 2 (L1)**:`evals/out/l1_ladder.md`,34 个 rung,33 可用 / 1 invalid / 1 MISS
  - 六个片子全探过,只有 `30331562…` 可用(需切 `-ss 28 -t 27`,track 3);fixture 8 个弯 / 347 帧
  - `MIN_TURNS` 一度降到 1 又恢复 3,生产行为与开工前等价,`analysis/tests/` **45/45 全绿**
  - L0 默认 step 由 5 改 10(真实 fixture 下 82s→6分30秒→57s),进 90s 预算
  - 修好 §4.1 坐标系问题**并让该假设可证伪**:采样位置对不上就标 INVALID,不再当成结论
  - 修好 shake / rider_size 的几何漂移;单个 rung 崩溃不再毁掉整轮
- **L1 查出三个新缺陷,都比 claim A–E 更要命**:
  - **§8.1 `create_proxy` 上采样毁掉它自己要判的 blur 信号** —— 246.8 → 21.8 方差,blur_score 61.7 → 5.4。闸门据此判"运动模糊"并让骑手去改拍摄手法,而问题是 pipeline 自己造的。这是失败模式 (1) 给出错误建议,发生位置正是本文 §1 预测的上游
  - **§8.2 `estimate_camera_stability` 几乎测不到抖动** —— 逐帧像素位移 4 倍变化,分数只动 1.6 分。中位光流在低纹理雪面上被无纹理区主导
  - **§8.7 `create_proxy` 拒收比 16:9 更细长的竖屏** —— 1080x2340(19.5:9,普通手机比例)直接 VideoError,报错信息不提宽高比
- 下一步:
  - 三个新缺陷按 §6 只提议未改动,**等你决定改哪个**。§8.1 的修法是一个表达式(禁止上采样),但改完 blur 阈值 50 要重新标定,整条 L1 全部数字都会变
  - **claim E 仍未验证** —— 本片 blur 恒在 5 附近,采样绕过测不出来。需要短边 ≥720 的原生素材
  - `rider_size` 轴的 blur 列是在测黑边不是测画面(pad 边缘抬高 Laplacian 方差),重跑该轴前要修
  - Phase 3 (L2 不变性) / Phase 4 (L3 弃权) 尚未编写
  - `evals/README.md` 尚未落盘
- 残留状态:
  - `quality.py` 是唯一改动过的生产文件,行为等价(字面量 3 → 具名 `MIN_TURNS = 3`)
  - **所有 L1 数字都继承一个上限**:fixture 源片是 320x568,proxy 上采样到 720x1278。这正是 §8.1 的病灶,也意味着这批数字在换到原生高分素材后必须重测
  - C.2 无法从当前 fixture 复现(sweep 里无 rejected),确认停留在记录上
  - `evals/out/` 全是生成物且被 gitignore,不进仓库
  - 无未跑的迁移、无未填的 key、无起着的服务
