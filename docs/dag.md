# Channel dependency graphs (DAG)

By default a pipeline's `channels` run as a flat list in declared order. Channel B
can instead declare that it depends on channel A:

```yaml
channels:
  - id: root
    executionMode: direct_provider
    prompt: prompts/root.md
  - id: left
    executionMode: direct_provider
    prompt: prompts/left.md
    dependsOn: [root]
  - id: right
    executionMode: direct_provider
    prompt: prompts/right.md
    dependsOn: [root]
  - id: merge
    executionMode: direct_provider
    prompt: prompts/merge.md
    dependsOn: [left, right]
```

## Execution semantics

- The executor performs a topological sort and runs channels in **dependency
  order**, grouped into independence **levels**. Channels in the same level have
  no dependency between them and run concurrently, subject to the existing
  global / per-provider concurrency caps.
- `ExecutionPlan.levels` records the resolved levels and `ExecutionPlan.topoOrder`
  the flattened topological order. `ExecutionPlan.isDag` is `true` when any
  channel declares `dependsOn`.

## Backward compatibility

A pipeline that declares **no** `dependsOn` anywhere is unchanged: `levels` is a
single level containing every channel in declared order, so all channels run
together exactly as before. The existing template variables
(`{{channel_results}}`, `{{previous_synthesis}}`, `{{recursion_depth}}`,
`{{run_id}}`) and the synthesis-runs-last behavior are untouched. Synthesis is not
part of the channel dependency graph; it still runs after all channels and
receives the full `{{channel_results}}` set.

## Passing upstream output into a prompt

A channel with `dependsOn` can read each upstream channel's output through two
additive template variables:

- `{{channel_results.<id>.parsed}}` — the upstream channel's parsed (validated)
  output, JSON-stringified.
- `{{channel_results.<id>.raw}}` — the upstream channel's raw provider text.

For example, a `merge` channel depending on `left` and `right`:

```
Left analysis: {{channel_results.left.parsed}}
Right analysis: {{channel_results.right.parsed}}
```

Unknown ids (not in `dependsOn`, or not yet produced) are left untouched so
authoring mistakes are visible.

## Cycles and unknown dependencies

A cyclic `dependsOn` graph, or a dependency on a channel id that does not exist,
is rejected by `validate-pipeline` (the S6 `PipelineValidator`) with a `cycle`
issue and a clear message naming the channels involved. The executor's
topological sort also throws rather than silently mis-ordering a malformed graph.

## Out of scope (future deviations)

- Dynamic channel generation (channels are still declared statically).
- Conditional channels (skipping a channel based on an upstream result).
