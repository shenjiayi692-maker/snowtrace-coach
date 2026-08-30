# Snowtrace 20-rider beta runbook

## Decision to make

The beta answers one question: does an evidence-first comparison help snowboard
carvers see one important movement difference and take one useful action on
their next run?

It does not validate exact biomechanics, framework superiority, monetization,
equipment recommendations, or a native app.

## Cohort

Recruit 20 snowboarders who can already link carved or carving-intent turns on
a groomed blue run:

- 12 intermediate riders and 8 advanced riders;
- at least 5 regular and 5 goofy riders;
- at least 5 follow-camera clips, with the rest using the recommended fixed 3/4
  view;
- a mixture of portrait and landscape phone footage;
- no minors in the first beta.

Exclude ski videos, terrain park tricks, powder, racing gates, very crowded
runs, and clips where consent for visible bystanders is unclear.

## Rollout

Run five concierge sessions first. Watch the rider complete the flow without
coaching them through the interface. Fix only blocking capture, upload, rider
selection, and explanation issues. Then release the same version to the other
15 riders; do not continuously change metric thresholds during that second
group.

## Rider protocol

1. Rider selects one reference clip and one recent clip of their own.
2. Rider records goal, stance, camera mode, and view.
3. Snowtrace runs browser preflight, upload, pose quality, rider selection when
   necessary, turn alignment, and confidence filtering.
4. If accepted, rider opens Show Me before reading the possible explanation.
   Confirm the evidence-frame skeleton sits on the intended rider and disappears
   after scrubbing away from that moment.
5. Rider reads one drill and submits the three in-product feedback answers.
6. Within 3–7 days, invite the rider to film the same goal again after trying
   the drill. Record whether they upload a second clip; do not count verbal
   intent as retention.
7. Conduct a 15-minute interview after the product task.

Interview prompts:

- “What difference did you see before reading the explanation?”
- “Which part felt credible or not credible?”
- “What would you do on your next run?”
- “Was choosing or filming the videos harder than interpreting the result?”
- “What would make you upload another clip?”

Avoid asking whether they “liked the AI.” Ask about evidence, action, and
repeat behavior.

## Independent safety and plausibility review

Have one qualified snowboard instructor review each accepted pair without
seeing the generated coaching first. They score:

- whether the highlighted phase is visually inspectable;
- whether the metric direction is plausible from that view;
- whether the possible explanation overreaches the evidence;
- whether the drill is safe and relevant;
- severity of any misleading claim: none, minor, material, safety-critical.

The instructor is not establishing a single canonical style. CASI, AASI, JSBA,
or another framework may be noted as context, but disagreement about style is
separate from an unsupported measurement claim.

## Instrumentation

The app records session creation, both-upload completion, analysis state,
ambiguous-rider state, accepted evidence, report completion, and three feedback
answers. The bearer-token-protected `/api/beta/metrics` endpoint summarizes the
funnel. Store `BETA_METRICS_TOKEN` in Sites runtime settings; never place it in
the beta issue log or a URL.

Before any beta upload, the interface requires the rider to confirm that they
are at least 18, have permission to use both clips (including visible people),
and understand the 30-day source-video retention period. The server rejects a
session unless the current consent version is present and records that version
on the anonymous profile. Do not collect videos through a side channel that
bypasses this gate.

## Source-video retention operation

Set an independent `BETA_OPS_TOKEN` in Sites runtime settings. Once per day,
send an authenticated `POST` request to `/api/ops/cleanup` with the token in an
`Authorization: Bearer ...` header. An optional JSON body such as
`{"limit":100}` bounds the batch from 1 to 200 videos. The operation deletes
both source and proxy objects whose 30-day expiry has passed, then records
`deleted_at` while retaining de-identified product evidence and funnel data.

The cleanup is idempotent and a small batch also runs opportunistically before
a new session is created. The daily operation is still required so deletion
does not depend on future rider activity. Review the returned `failures` count;
any nonzero value must be investigated and retried before accepting more beta
uploads. Never put the operations token in a URL, issue log, or client code.

Keep a separate de-identified issue log with rider number, device/browser,
camera mode, failure stage, visible symptom, resolution, and whether it blocked
completion. Do not copy source videos into the issue log.

## KPI gates

Use absolute counts alongside percentages because the cohort is small.

| Signal | Go | Investigate / iterate | Stop or redesign |
| --- | ---: | ---: | ---: |
| Complete both uploads | at least 16/20 | 12–15/20 | fewer than 12/20 |
| Reach accepted evidence or actionable rider-selection state | at least 14/20 | 10–13/20 | fewer than 10/20 |
| Instructor: metric direction plausible | at least 80% of accepted reports | 65–79% | below 65% |
| Rider can see the highlighted gap | at least 70% | 50–69% | below 50% |
| Report useful or partly useful | at least 70% | 50–69% | below 50% |
| “Yes” to trying the drill | at least 60% | 40–59% | below 40% |
| Second upload within 7 days | at least 8/20 | 5–7/20 | fewer than 5/20 |
| Material or safety-critical misleading claims | 0 | — | 1 or more |

Operational targets for this small beta:

- median time from completed upload to state/result under 8 minutes;
- fewer than 20% unexplained technical failures;
- every rejected clip receives a specific recapture instruction;
- every accepted claim has visible confidence and two Show Me timestamps.

## Go / no-go logic

Go to the next product iteration only if there are no material misleading
claims and the evidence-plausibility, Show Me, usefulness, and second-upload
gates all pass.

If capture success is low but instructor plausibility is high, invest in Video
Intelligence: filming guidance, auto-trim, rider selection, and quality repair.
Do not add more biomechanics metrics.

If capture and evidence pass but usefulness or drill intent is low, improve the
evidence presentation and curated drill mapping. Do not train a pose model.

If riders understand and value reports but do not return, test reminders,
progress comparison, and a human-coach review option before building a native
app.

Stop the beta immediately for unauthorized video exposure, deletion failure,
safety-critical coaching, or a pattern of confident claims unsupported by the
visible evidence.

## Things not to add during the beta

- ski analysis, park tricks, racing, or powder;
- exact edge angle, force, pressure, or 3D physics;
- board detection as a requirement for coaching;
- free-form coaching chat;
- framework scoring or instructor certification claims;
- equipment recommendations, affiliate links, payments, or subscriptions;
- native iOS/Android clients;
- custom pose-model training.
