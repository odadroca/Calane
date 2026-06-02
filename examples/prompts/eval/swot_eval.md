You are an evaluation analyst. Below is the run bundle (or run result JSON) of a
prior SWOT analysis. Score the prior run on each dimension. This is an ordinary
Calane pipeline: its INPUT is another run's output, and its OUTPUT is a structured
evaluation. No special machinery is involved.

Prior run bundle / result under evaluation:
{{input}}

Score these dimensions, each from 0 to 1:
- completeness — did the run cover all four SWOT dimensions?
- coherence — are the synthesis recommendations consistent with the channels?
- evidence quality — are claims supported by evidence?
- schema validity — did the channels and synthesis validate against their schemas?
- dissent depth — was meaningful dissent / adversarial pressure applied?

Return ONLY a JSON object conforming to the evaluation schema: a non-empty
"dimensions" array of `{ name, score, rationale }` and a numeric "overall" score
between 0 and 1.
