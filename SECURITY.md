# Security policy

## Supported versions

Security fixes target the latest release and the current `main` branch. Older
releases are not maintained separately; update before checking whether an issue
still occurs.

## Reporting a vulnerability

Start with a [new issue](https://github.com/jiangkoumo/ego-decision-layer/issues/new)
containing only a request for a private reporting channel. Do not include exploit
details, credentials, personal data, or authenticated browser captures in a public
issue. Wait for the maintainer to arrange a private channel before sharing
sensitive details. GitHub private vulnerability reporting is not currently enabled.

Once a private channel is available, include the affected version or commit,
platform, a minimal reproduction, expected and actual behavior, and the potential
impact. Use synthetic credentials and redact browser content. Reports are reviewed
on a best-effort basis; there is no guaranteed response or fix timeline.

## Security boundaries

- The skill runs commands and controls ego lite pages using the current user's
  browser session. Review task goals and use a dedicated account or browser
  context when appropriate.
- Execution guards reject certain dangerous actions, stale targets, and covered
  controls. The dangerous-action vocabulary is finite and is not a complete
  authorization policy. Visual coordinate actions have different checks from
  semantic DOM actions; see the README limitations.
- Model backends receive task instructions and observed page data. Structured
  extraction also sends page content to the configured text model. Choose
  backends appropriate for that data.
- Keep API keys outside the repository in credential files with restrictive
  permissions. Never include real keys in examples, test fixtures, issues, or
  diagnostic output. Rotate credentials exposed in public immediately.
- This project does not modify the signed ego lite application bundle. Skill
  routing changes are made outside the application and can be restored with
  `scripts/wire-agent-skills.sh --restore`.
