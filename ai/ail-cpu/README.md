# AIL AI — CPU training experiment

This is a real, deliberately small first training run for AIL AI. It trains a byte-level causal Transformer from random initialization on GitHub Actions CPU.

## What it is
- Small prototype (roughly a few hundred thousand parameters; exact count is recorded in the run).
- Combines the CHEATLAB repository's source files with the WikiText-2 training split.
- Produces checkpoints and JSONL loss metrics as a GitHub Actions artifact.

## What it is not
- Not the planned 1-billion-parameter model.
- Not a production assistant and not evidence of useful coding performance.
- The CPU run does not connect the checkpoint to the public AIL chat yet.

## Dataset attribution
WikiText-2 is provided by Salesforce's WikiText project. Preserve its attribution and license terms when redistributing derived datasets or checkpoints. CHEATLAB source is included as project-owned training material.

## Start / monitor
A push to the configured paths starts the workflow. Open Actions → “AIL AI CPU training experiment”. On success, download the `ail-ai-cpu-experiment` artifact containing checkpoints, model card and training metrics.
