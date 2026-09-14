# Design decisions

The README states what the system refuses to compare. [`LLM_COACHING_CONTRACT.md`](./LLM_COACHING_CONTRACT.md) states what the renderer is permitted to do with an accepted comparison. This document states why these boundaries and not others, what the alternative was in each case, and what the choice cost. Six decisions mattered more than the rest.

## The analysis service is a separate process, not a library

Pose estimation could run in the browser. MediaPipe supports it, it costs nothing to host, and it removes an entire deployment target.

It was rejected because a coaching claim has to be reproducible from stored evidence months after the run, and a browser-side pipeline produces different results on different phones, browsers, and thermal states — the same clip would support different advice depending on where it was analyzed. It is also not available here even if that were acceptable: rotation, variable frame rate, and timebase drift have to be normalized by FFmpeg before pose runs at all, and a Worker cannot run FFmpeg. So `analysis/` is an independent, containerized, CPU-friendly service, and the web app reaches it only through short-lived HMAC media grants.

**Cost:** a second deployment target, signed media URLs, an allowlisted callback, idempotent terminal handling, and a 12-minute lost-callback watchdog. Nearly all of the deployment complexity in this repository exists to pay for this one decision.

## A closed gate returns a named next action, never a lower-confidence number

The ordinary design returns the best comparison available, attaches a confidence score, and lets the interface dim it.

That was rejected because confidence bars are not read. A rider shown a specific instruction with a small grey caveat will act on the instruction, and if the comparison was invalid they will practice the wrong movement on real snow. This is the asymmetry the whole system is built around: a missed observation costs a rider nothing — they film again — while a confident instruction that is an artifact of the footage costs them the thing they came for. So each gate resolves to one of a small set of named outcomes: recapture with the failing check named, rider selection, incompatible pairing, no reliable gap, or a technical retry. None of them is a weakened version of the coaching result, and none of them is reachable by lowering a threshold.

**Cost:** a substantial share of real runs will end with no coaching at all. That is why [`BETA_RUNBOOK.md`](./BETA_RUNBOOK.md) treats recapture coverage as a first-class KPI rather than a failure rate, and why the go/iterate/stop decision is deliberately delayed until the full seven-day window instead of being read off early numbers.

## The noise floor is the rider's own variability, not a fixed threshold

A per-metric constant — eight degrees of knee flexion, say — is simpler to implement and far easier to explain to a rider.

It was rejected because it answers a question nobody asked. A ten-degree difference from a rider whose own turns vary by twelve degrees is noise, and reporting it as a gap means handing out a drill for random variation. The same ten degrees from a rider who repeats within three is a real, coachable pattern. So the effect size in `comparison.py` is computed against `max(metric threshold, 1.5 × reference variability, 1.5 × rider variability)`: the constant survives only as a floor, and the bar rises on its own for inconsistent footage. Evidence is admitted only at confidence ≥ 0.70, effect size ≥ 1.0, and at least two paired turns.

**Cost:** two riders with the same mean difference can get different answers, which is correct and still needs explaining. An erratic rider also needs more turns before anything clears the floor, so the riders most likely to want feedback are the ones most likely to be told there is no reliable gap yet.

## Normalization rewrites coordinates, never the video

When one rider travels left-to-right and the other right-to-left, the obvious fix is to mirror one clip so both look the same, and then compare them as they are.

That was rejected for two reasons, and the second is the one that settles it. Signed 2D metrics invert silently under a mirror, so a fore/aft difference can flip sign with nothing in the pipeline failing or warning. And the Show Me overlay exists so a rider can inspect the frame behind a claim — if that frame is a mirrored version of footage they never shot, it stops being evidence and becomes an illustration. Screen direction is therefore canonicalized in metric coordinates only; the source video and its overlay are never altered. The same rule governs stance: lead and trail are resolved per clip from the rider's declared stance rather than assuming left is lead.

**Cost:** every metric has to declare whether it is direction-sensitive, and stance, travel direction, and first-turn edge become required inputs the rider must supply rather than conveniences the system infers. A wrong answer at capture time is now a wrong comparison the gates cannot catch.

## The language model renders evidence and nothing else

The natural product shape is to hand the model the pose data and let it coach. That is the whole product, given away in one call.

A model that receives landmark streams chooses which metric matters and invents a cause, and both of those are the thing being built. So the renderer is invoked only after the gates have already selected one comparison and one permitted drill. It receives a structured envelope with no video, no landmarks, and no user identity, and its response is validated before display: the echoed metric and edge must match the stored evidence, the drill must be in the allowed list, new numbers are rejected, and prohibited biomechanical or medical language is rejected. On refusal, timeout, validation failure, or a missing key, the deterministic template in `lib/coaching.ts` renders instead and the fallback reason is recorded.

The same reasoning makes the report an artifact rather than a render. A rider can reopen a session weeks later, and if the browser rendered the report a newer bundle would silently produce different wording for the same run. Reports are built server-side, persisted once as a versioned `coach-report-v1` with model, prompt, schema, and drill-library versions recorded, and a repeated terminal callback reuses the stored result rather than rewriting it.

**Cost:** the coaching language is narrower and more repetitive than an unconstrained model would produce. The drill library has to be curated by hand, adding a metric means adding drills that explicitly allow it, and changing how a report reads requires a migration path for reports already stored.

## The gate measures the footage the rider shot, not the copy the pipeline made

Scoring the analysis proxy is the cheap and obvious choice: the pipeline has already decoded and normalized it, so sampling it costs nothing extra. That is what the code did, and it was wrong in a way that took a measurement to see.

`create_proxy` scales the short side to 720, so the 568×320 eval clip was interpolated 2.25×. The interpolation invents no detail and flattens exactly the high-frequency content sharpness is computed from: Laplacian variance fell from 246.8 on the source to 21.8 on the proxy, and `blur_score` with it, from 61.7 to 5.4. The gate then read that number, called the clip motion-blurred, and told the rider to find brighter light and avoid digital zoom — advice about their filming, for a defect the pipeline had introduced one step earlier. The measurement system was contaminating the thing it measured, and until it was fixed every rung in the degradation ladder was capped at `limited` because of it. `1b577a3` records the measurement; `2506438` moves `sample_visual_quality` onto the source. `estimate_camera_stability` deliberately stays on the proxy, because comparing frames a fixed interval apart needs the normalized CFR 30 timebase.

**Cost:** the two capture checks now read from two different files, which is a genuine asymmetry someone will eventually have to re-justify. Worse, the blur threshold of 50 was set against the degraded numbers, and re-deriving it against the source distribution moves every measurement in the current ladder. That re-derivation is recorded rather than attempted, because one clip is not a calibration set.

## What the eval suite changed

Most of the gates above were not designed up front. They were added after finding a comparison the system was making and had no right to make — `Gate comparisons by camera view`, `Normalize metrics by rider stance`, `Align evidence by snowboard edge`, `Anchor turn alignment to detected apex`, `Gate metrics by landmark reliability`, `Normalize phone video time and rotation`, `Normalize opposite screen travel directions`. Each closed a class of false comparison that the previous version had reported as a confident coaching instruction.

`evals/` exists because that pattern kept repeating, and it produced one lesson often enough to be worth stating as a rule: **a guard that has never been seen to fail is not a guard.** It arrived three times. A rung-level crash handler left `render()` outside the `try`, so the first render failure destroyed 32 completed rungs (`2481e09`). A quality sampler that read ten fixed, publicly derivable frame positions let a clip blurred everywhere except those ten score 53 against 54 for genuinely clean footage, while the same blur applied uniformly scored 1 — 1.2% of the clip deciding the verdict, at indices anyone could compute (`6af0fc7`). And the abstention test itself passed the first time it ran, for the wrong reason: the fixture had been captured with `--first-edge unknown`, so every turn was labelled `unknown` while `compare_videos` only iterates heelside and toeside. Nothing matched, no evidence could be produced for any input, and shifting both knees by 10% of frame height also returned zero (`e91a848`).

That last one is why `evals/abstention.py` ships a control test beside the check it is guarding. The self-comparison test asserts that a clip compared against itself yields no coaching gap, because any evidence there is manufactured. The control asserts that a plainly real difference does produce one. Either test alone is satisfied by a component that always says nothing; together they pin the comparison layer between silence and confabulation.

Three of the four abstention cases in the design are deliberately not written. They need footage that does not exist yet — two clips of the same rider on the same run — or a live job queue, and against mocks they would test the mocks. The suite stops where it stops for a related reason, recorded in `HANDOFF.md`: the eval apparatus had come to outweigh the service it tests, L1 has one usable clip where the design asked for ten, and calibration only becomes meaningful once a beta produces real footage. The bug-finding earned its keep, with three production defects fixed, two of which would have produced wrong advice or failed uploads for real riders. The five-layer framework around it did not.
