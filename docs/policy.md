# Enforcement policies

Enforcement policies gate channel execution at two hook points around every
channel. They are distinct from the **recursion policy**
(`PolicyPluginInterface.decideRecursion`), which only decides loop continuation
across recursion depths.

## The contract

```ts
interface EnforcementPolicyInterface {
  readonly policyId: string;
  beforeChannel?(ctx): { decision: "proceed" | "skip" | "abort"; reason: string };
  afterChannel?(ctx): { decision: "continue" | "halt"; reason: string };
}
```

- `beforeChannel` runs before a channel executes:
  - `proceed` — run the channel.
  - `skip` — do not run this channel; continue with the rest of the run.
  - `abort` — halt the whole run; active provider calls are aborted via an
    `AbortSignal` (where the provider supports it).
- `afterChannel` runs after a channel produces a result:
  - `continue` — keep running.
  - `halt` — stop the run after this channel (no further channels start).

Policies are registered on the executor via the `policies` constructor option
and dispatched in registration order at each hook. When at least one
enforcement policy is registered, channels in a recursion depth run
**sequentially** so cumulative-cost policies observe prior channel cost before
the next channel starts. With no policies registered, the prior concurrent
execution behaviour is preserved unchanged.

## Recording and visibility

- Every hook invocation appends a `PolicyDecision` to `RunResult.policy`
  (`{ policyId, hook, channelId, decision, reason }`).
- The run bundle includes `policy_decisions.json` (the full `RunResult.policy`
  array).
- Each decision is emitted as a `policy.decision` telemetry event carrying the
  attributes `policy.id`, `policy.hook`, `policy.decision`, and `policy.reason`.
  The OpenTelemetry sink records these as span events on the run span and sets a
  `policy.decision` attribute on the run span.

## Policies are classes; their config is TypeBox

Policies themselves are plain TypeScript classes. Their **configuration** is the
TypeBox single source of truth, so pipeline authors supply schema-validated
config (no second schema system, no Zod).

## CostBudgetPolicy

The first concrete policy enforces cost ceilings using only **known**
(already-incurred) cost — it never predicts the cost of an unrun channel.

Config schema (`CostBudgetPolicyConfig`):

| field                  | meaning                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| `maxCostUsdPerRun`     | hard ceiling on summed channel cost for the whole run (USD).        |
| `maxCostUsdPerChannel` | hard ceiling on a single channel's cost (USD).                      |
| `safetyMargin`         | 0..1 fraction applied to the per-run ceiling (e.g. `0.1` treats the budget as reached at 90% of the ceiling). |

Behaviour:

- `beforeChannel` aborts the run when the known run cost so far has reached the
  margin-adjusted per-run ceiling (no point starting another channel).
- `afterChannel` halts the run when the channel that just ran exceeded the
  per-channel ceiling, or when the run total has reached the margin-adjusted
  per-run ceiling.

Example:

```ts
import { CostBudgetPolicy, PipelineExecutor } from "@llm-pipe/core";

const executor = new PipelineExecutor({
  registry,
  providers,
  store,
  policies: [new CostBudgetPolicy({ maxCostUsdPerRun: 0.01 })],
});
```

A run that exceeds `maxCostUsdPerRun` is halted mid-execution, the halting
decision is recorded in `RunResult.policy`, and `policy_decisions.json` in the
exported bundle records the full decision trail.
