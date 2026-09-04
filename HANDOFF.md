# HANDOFF — snowtrace eval suite

This supersedes the premise of the original `evals/` handoff. That document was
written **without a checkout**: field names were reconstructed from usage and
five claims were read off the GitHub web view rather than measured.

The source is now available locally at `analysis/src/snowtrace_analysis/`
(11 modules, 1679 lines). Everything below was verified by reading it. No eval
code has been executed yet — that remains true.

---

## 0. Environment as of 2026-09-04

| | state |
|---|---|
| git | initialized this session; **nothing committed yet** |
| `evals/` | **does not exist on disk** — the three files exist only as pasted text |
| clean clips | 2 (see §5); one is unusable |
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

| clip | duration | candidates | verdict |
|---|---|---|---|
| `5288e320…` | 2.53 s | — | unusable, under the 3 s pipeline floor |
| `70e23e90…` | 3.97 s | 2, ambiguous | marginal |
| `6634c1c3…` | 22.53 s | 4, ambiguous; coverage 0.9–15%, bbox 0.03–0.16 | wide shot, riders too small |
| `5272aec6…` | 10.10 s | **0** | no track survives the 3-observation filter |
| `372bdb2f…` | 11.83 s | 1, unambiguous, score 0.54, bbox 0.283 | **the fixture** |

Only one clip of five yields a clean single-rider track. L1 remains blocked on
footage, not on code.

### Claim C.2 confirmed on real data

The first capture of `372bdb2f` returned **`readiness_score: 91` with status
`rejected`** (`hard_failures: ["insufficient_turns"]`). The tail-branch
disagreement predicted in §1 from source reading is real, not theoretical: the
rider is shown a 91 next to a rejection.

### `MIN_TURNS` lowered 3 → 1

`quality.py` now has a named `MIN_TURNS = 1` constant. Done at the owner's
explicit instruction so the single usable fixture (2 detected turns) yields a
non-degenerate decision surface; with the floor at 3 every sweep point was
`rejected`.

This contradicts §6's "do not loosen a threshold" and it is a deliberate,
owner-made exception, recorded here so it is not mistaken for drift.
Consequences:

- **`analysis/tests/test_quality.py::test_two_turns_are_not_enough_for_same_edge_pairing`
  now fails** (`'full' != 'rejected'`). 44 of 45 tests pass. The test has
  **not** been edited — changing it to match a loosened threshold is the exact
  anti-pattern this suite exists to catch. Deciding its fate is a product call.
- The score reference stayed at 3.0 deliberately: the reject floor and the
  normalization reference are separate concepts, and coupling them would be a
  product decision. The side effect is a **new instance of the claim-B defect
  shape** — floor 1, score reference 3 — now flagged in `surface.md`.
- **Claim A is refuted while the floor is 1.** `turn_score` discriminates in
  the window `[MIN_TURNS, 3)`, which is now `{1, 2}` rather than empty. Raising
  the floor back to 3 restores the claim. `gate_surface` computes this from
  `quality.MIN_TURNS` rather than a literal, so the claim cannot silently go
  stale again.

### L0 output

`evals/out/surface.md`, 111,132 configurations, 82 s, exit 0.

- `full` 14% / `limited` 86% / `rejected` 0%
- **Claim C.1 confirmed at scale:** 40,320 configurations (36.3%) scored
  readiness ≥ 75 and were demoted to `limited` by blur or stability alone —
  follow-camera and metric-visibility demotions excluded so the cause is
  unambiguous. Worst case: readiness 91, blur 95, stability 40 → `limited`.
- Flip points: blur at 50, stability at 50, exposure **never** — exposure has
  no hard threshold and its 5 weight never moves a verdict on this fixture.
- `metric_visibility` constant at 100 across all 12 mode/view/stance
  combinations. Fixture-scoped, not a proven defect.

### Two further defects found while running

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

### Constraint pressure

§7's "a stranger runs L0 in under a minute" — the default step-5 grid takes
**82 s**. `--step 10` brings it to ~12 s and still lands on the 50 flip points.
Whether to move the default is a call not yet made.

---

## 进度(最后更新 2026-09-04)

- 已完成:
  - 通读本地 `analysis/src/snowtrace_analysis/` 全部源码,原 handoff「无 checkout」的前提作废
  - claim A/B/C/D/E 全部**静态确认**,其中 C 比原文严重(四条绕过 readiness 的降级路径)
  - 原 handoff §4 推测的字段名核对完毕,查出 3 个会直接抛异常的错(见 §3)
  - 查出两个 intent 级问题(§4.1 sampling_evasion 构造不出目标反例;§4.2 dead-weight 断言恒失败)
  - `git init` 完成;`.gitignore` 增加 evals 产物与视频排除
  - **Phase 0 完成**:`evals/{__init__,fixture,gate_surface,degrade}.py` 已落盘,§3 四个阻塞点全修,运行中又发现两个(见 §7)
  - 五个片子全部探过,只有 `372bdb2f…` 能出干净单人 track,已抓成 `evals/fixtures/track_clean.json`(284 KB,69 帧,2 个弯)
  - **claim C.2 在真实数据上确认**:readiness 91 + rejected
  - **Phase 1 完成**:`evals/out/surface.md` 已生成,claim A 判为「当前配置下证伪」、C.1 确认(36.3%)、D 早已确认
- 下一步:
  - 决定 `test_two_turns_are_not_enough_for_same_edge_pairing` 怎么办(现在是红的,我没动它)
  - 决定 `MIN_TURNS` 是留 1 还是恢复 3;若恢复,claim A 自动重新成立,且需要重跑 L0
  - Phase 2 (L1) 阻塞在素材:需要能测出 ≥3 个弯的近景单人片子
  - `evals/README.md` 尚未落盘(设计文档,原 handoff §2 列为已存在)
- 残留状态:
  - **git 仓库已建但一次提交都没有** —— 全部文件 untracked,包括这次所有产出
  - `analysis/tests/` 1 红 44 绿,红的那个是 `MIN_TURNS` 改动的直接后果,是预期的、未处理的
  - `quality.py` 已被修改(生产代码),这是本次唯一改动的非 eval 文件
  - `evals/out/surface.json` 有 65 MB(已被 gitignore),不需要可直接删
  - `.eval-work/` 里有留下的 proxy 文件;`.snowtrace-work/` 是更早的遗留
  - 无未跑的迁移、无未填的 key、无起着的服务
