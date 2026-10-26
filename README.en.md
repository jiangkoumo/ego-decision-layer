![ego-decision-layer](docs/banner.svg)

English · [简体中文](README.md)

# ego-decision-layer

A pluggable decision layer for ego lite browser automation. By default, TypeSafe's System One model **Jev** reads an indexed element table and selects an operation and its target in one request. Code handles observation, execution, guards and completion checks. OpenAI-compatible decision backends are also supported.

**Latest release: v0.12.0.** This release expands the controlled benchmark to 12 tasks, adds an initial real Jev two-host benchmark for HN and Wikipedia, and covers timeout, launch and resource-cleanup failures with offline regressions. It retains the external Chrome CDP entry, experimental MCP tools, `update` / `--version` and Windows path fixes. Download source from the [release page](https://github.com/jiangkoumo/ego-decision-layer/releases/latest).

## Requirements and installation

You need ego lite with a working `ego-browser` CLI. The default Jev backend also needs a TypeSafe API key. This project installs outside the ego lite application bundle.

Install the skill:

```bash
npx skills add jiangkoumo/ego-decision-layer
```

The skill includes its engine and CLI. For a user-level installation at `~/.agents/skills/ego-decision-layer`, invoke the CLI at the path shown below. Adjust it if your agent uses another skill directory.

Alternatively, clone and install:

```bash
git clone https://github.com/jiangkoumo/ego-decision-layer.git
cd ego-decision-layer
./install.sh --test
```

The installer links the CLI into `~/.local/bin` and normally installs a routing overlay at agents' external `ego-browser` skill entries. Use `./install.sh --no-wire` to skip the overlay. It never modifies the ego lite application bundle. The overlay may need refreshing after ego lite synchronizes its official skills.

Claude Code plugin installation is also available:

```text
/plugin marketplace add jiangkoumo/ego-decision-layer
/plugin install ego-decision-layer@ego-decision-layer
```

Keep the Jev key in `~/.config/typesafe/api_key` as one line, with file permissions `600`. The embedded browser runtime does not inherit custom shell environment variables. The CLI resolves credentials in its parent process; scripts running directly inside `ego-browser nodejs` should use credential files. See [SKILL.md](SKILL.md) for the full lookup chain. Never put credentials in this repository.

## Run and verify a task

```bash
"$HOME/.agents/skills/ego-decision-layer/scripts/ego-decision-layer" \
  --url "https://en.wikipedia.org/wiki/Main_Page" \
  --text "Jev" --until "/wiki/Jev" --steps 5 \
  "type Jev into the search box and submit"
```

From a clone, use `./scripts/ego-decision-layer`. If installed on PATH, use `ego-decision-layer`.

Verify all three: exit code `0`, `success: true`, and a final URL containing `/wiki/Jev`. A deterministic completion check returns `check_passed` or `check_passed_after_step`. The model's `jev_done` alone still needs final-state verification.

| Argument | Meaning |
| --- | --- |
| `--url` | Starting URL |
| `--text` | Text to enter; repeat for multiple candidates |
| `--until` | Required substring of the final URL |
| `--steps` | Maximum steps; default 10 |
| `--space` | Reuse an existing TaskSpace by ID |

Exit codes: `0` success, `1` goal not reached, `2` invalid arguments, `3` missing Jev credentials. Successful tasks close their TaskSpace by default. Failed tasks retain it for inspection and report its ID. Prefer URL paths or DOM state over UI-string checks, because automatic translation can change labels.

## External Chrome (since v0.11.0)

Use `--cdp-endpoint` to connect from ordinary Node to an external Chrome with remote debugging enabled. It requires Node 22+. The default ego lite entry continues to use `ego-browser`.

```bash
./scripts/ego-decision-layer --cdp-endpoint http://127.0.0.1:9222 \
  --url "https://en.wikipedia.org/wiki/Main_Page" \
  --text "Jev" --until "/wiki/Jev" --steps 5 \
  "type Jev into the search box and submit"
```

CDP mode creates its own page and leaves the external browser and existing tabs open. Use `--keep-space` to retain the new page for inspection. Ego TaskSpace options `--space` and `--keep` cannot be combined with CDP mode. This path does not require ego lite or refresh agent routing. Jev credentials or an OpenAI-compatible decision backend are still required. Controlled tasks have passed on both hosts; this entry ships with v0.11.0 (real CDP verified on macOS only). Run `node bench/test-host-integration-live.mjs --suite` with Node 22+, Chrome and Jev credentials to reproduce controlled acceptance, live HN navigation, form submission and shared CLI integration. Set `EGO_CDP_CHROME` to override the Chrome executable. Optional `--wiki` adds Wikipedia search, which has both succeeded and failed within a five-step budget.

## Update an installation

Since version 0.10.0:

```bash
ego-decision-layer --version
ego-decision-layer update
ego-decision-layer update --test
```

Git installations fast-forward from the current branch's upstream. Skill copies update only this skill using their recorded source and original installation scope. Dirty tracked files, pinned revisions, update failures and missing installation records produce nonzero exits. Ordinary untracked files are retained; Git rejects collisions. ZIP and plugin installations without matching records must update through their original channel. Older versions need one update through their original channel before these commands become available.

`update --test` runs a real browser smoke test after updating. Maintenance commands do not need a browser, model or key unless a smoke test is requested.

## Capabilities and limits

| Capability | Current behavior |
| --- | --- |
| Linear browser tasks | Observe, decide, execute and verify inside one browser process; use explicit completion checks |
| Execution guards | Reject stale, covered, unavailable and unresolved frame targets before dispatch; a Chinese/English keyword guard blocks matching dangerous actions |
| Structured extraction | `--extract` / `--schema` and `extract()` produce JSON validated against a supported schema subset; schema validity does not prove business correctness |
| Action cache | Validated replay can skip model requests; full URL, control state, text candidates and task context participate in cache identity |
| Action batches | Execute backend-provided action sequences with preflight guards and one final settle; default Jev does not automatically generate batches |
| Canvas/SVG fallback | Scan geometric regions and accept an injected `visualGrounder`; the default single-region strategy clicks its center and does not interpret image pixels |
| Decision backends | Default System One; configurable OpenAI-compatible backends retain execution guards but do not provide calibrated confidence |
| Host support | ego lite and external Chrome CDP (Node 22+); v0.11.0 also ships an optional experimental stdio MCP entry. Real CDP/MCP runs have been verified on macOS only |

A cache hit with `decideMs = 0` only means the model request was skipped. Observation, validation and execution still take time. Actions with uncertain outcomes stop rather than being blindly replayed. Keyword guards are heuristic, cross-origin iframes are unsupported, and real CAPTCHA handling has not been validated.

For extraction:

```bash
ego-decision-layer --url "https://news.ycombinator.com" \
  --extract "Extract the first 5 news titles, links and scores" \
  --schema '[{"title":"string","url":"string","score":"string"}]'
```

Extraction needs a separate text-model configuration; see the [full configuration guide](README.md). For library use, import the stable exports from `scripts/decider-loop.mjs`, including `runJevAutonomousLoop`, `runJevStep` and `extract`. The [skill reference](SKILL.md) documents their options and runtime constraints.

## Measurements and reproduction

Published measurements are historical runs under specific host, model and task conditions. They do not establish a current general success rate. Reports preserve corrections and limitations:

- [VERIFY-REPORT.md](VERIFY-REPORT.md): pre-registered paired comparisons and their decision rules.
- [PORT-REPORT.md](PORT-REPORT.md): engine rebuild measurements and phase breakdowns.
- [BH-PORT-REPORT.md](BH-PORT-REPORT.md): scrolling fixes and paired task results.
- [bench/raw/](bench/raw): original measurement data.
- [CHANGELOG.md](CHANGELOG.md): fixes, corrected claims and unverified boundaries.

Reproduce the current single-process arm or compare with the per-step LLM driver:

```bash
cd examples/bench
./run-pair.sh A
./run-pair.sh B kimi-k3
```

Review `task.json`, model configuration and credential paths first. See [examples/bench/README.md](examples/bench/README.md). The historical comparison against another browser stack uses archived raw data and analysis scripts; its old driver is no longer shipped.

Checks that need no browser or credentials:

```bash
node bench/test-update.mjs
node bench/test-release-consistency.mjs
node bench/test-guardrails.mjs
```

The [Chinese guide](README.md) lists browser integration tests and additional reproduction commands. Demo footage is generated from real runs; see [docs/README.md](docs/README.md).

## Next steps

The [roadmap](ROADMAP.md) records the Host Adapter, external Chrome CDP entry, first shared controlled task suite and minimal MCP entry delivered in v0.11.0. Version 0.12.0 delivers the second benchmark batch: 12 controlled tasks and an initial real Jev two-host measurement. See the [live benchmark guide](bench/live-benchmark/README.md) for its fixed command, raw results and small-sample limits. Image grounding, additional decision backends and bounded escalation to a larger model require separate validation. ego lite remains a first-class host.

## Attribution and license

Built on [ego lite](https://github.com/citrolabs/ego-lite), with parts of the observation, response validation and execution architecture adapted from [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast). See [THIRD-PARTY.md](THIRD-PARTY.md) and [THIRD-PARTY-ASSESSMENT.md](THIRD-PARTY-ASSESSMENT.md) for attribution and scope.

MIT. See [LICENSE](LICENSE).
