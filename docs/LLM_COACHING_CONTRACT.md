# LLM coaching contract

## Role

The language model is an evidence renderer, not a biomechanics engine. It may
turn one accepted comparison into concise coaching language, but it cannot
choose a different metric, invent a cause, calculate a new value, or select a
drill outside the curated library.

The current M0 uses deterministic templates in `lib/coaching.ts`. They remain
the production fallback even after an LLM renderer is enabled.

## Invocation gate

Call the renderer only when all of the following are true:

- both videos passed the pose quality gate;
- at least two turns were paired;
- the top evidence item has confidence of at least 0.70;
- effect size is at least 1.0 after the per-metric noise floor;
- the metric is allowed for both camera views;
- one or more drill-library entries explicitly allow the metric.

No LLM call is made for `rejected`, `needs_rider`, `needs_markers`, or empty
evidence states.

## Input envelope

Send structured text only. Do not send source video, pose landmarks, user email,
filenames, or free-form reference-framework doctrine.

The analysis callback may attach one 2D pose snapshot for each Show Me evidence
frame. Those snapshots are renderer-only visual evidence and are deliberately
removed from the LLM input envelope.

```json
{
  "schema_version": "coach-input-v1",
  "locale": "en",
  "goal": "medium",
  "rider_stance": "regular",
  "reference_stance": "goofy",
  "rider_camera_mode": "fixed",
  "reference_camera_mode": "follow",
  "rider_view_angle": "three-quarter",
  "reference_view_angle": "three-quarter",
  "evidence": {
    "metric_id": "knee_flexion_lead",
    "phase": "apex",
    "reference_value": 44,
    "user_value": 57,
    "difference": 13,
    "unit": "degrees",
    "confidence": 0.86,
    "effect_size": 1.7,
    "paired_turns": 3,
    "reference_timestamp_ms": 8400,
    "user_timestamp_ms": 6900
  },
  "allowed_drills": [
    {
      "id": "progressive-flexion-v1",
      "title": "Progressive flexion turns",
      "steps": ["..."],
      "success_cue": "..."
    }
  ],
  "measurement_limitations": [
    "2D monocular pose",
    "no force or pressure inference",
    "no exact edge angle",
    "no physical 3D reconstruction"
  ]
}
```

## Output envelope

Use the Responses API with strict Structured Outputs. Every field is required
and every object sets `additionalProperties` to `false`.

```json
{
  "schema_version": "coach-output-v1",
  "metric_id": "knee_flexion_lead",
  "observation": "...",
  "possible_explanation": "...",
  "drill_id": "progressive-flexion-v1",
  "drill_intro": "...",
  "success_cue": "...",
  "limitation": "..."
}
```

The server verifies that `metric_id` matches the evidence and `drill_id` is in
`allowed_drills`. It rejects new numbers, absolute diagnosis, and claims about
force, pressure, equipment causality, exact edge angle, or true 3D motion.

## System instruction

Use a short, versioned instruction:

> Render one accepted snowboard carving comparison into cautious coaching
> language. Use only the supplied evidence and one supplied drill. Describe
> causes as possibilities. Never infer force, pressure, pain, injury, equipment
> suitability, exact edge angle, or 3D physics. Do not add measurements. Return
> only the required structured fields.

The user message is the serialized input envelope. No conversation history is
needed.

## Validation and fallback

1. Validate the strict response schema.
2. Confirm echoed metric and selected drill IDs.
3. Reject numerical claims not present in the input.
4. Reject prohibited biomechanical or medical language.
5. Enforce short field limits before display.
6. On refusal, timeout, API error, validation failure, or missing API key, use
   the deterministic template and record the fallback reason.

The UI always displays the underlying confidence, paired-turn count, phase, and
Show Me timestamps independently of the generated wording.

## Versioning and evaluation

Persist model, prompt, input-schema, output-schema, and drill-library versions
on every report. Before beta, run a fixed evaluation set containing accepted,
limited, rejected, ambiguous-rider, adversarial text, and unsupported-metric
fixtures. A renderer release passes only if it never changes the evidence item,
never selects a disallowed drill, and never upgrades uncertainty into a factual
diagnosis.

The model name is a deployment setting, not a hard-coded product assumption.
Choose and pin it when API credentials are configured; changing it requires the
same evaluation set.
