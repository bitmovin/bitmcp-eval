# @bitmcp-eval/cli

**Evaluate how LLM agents actually use your MCP server.**

`bitmcp-eval` runs your prompts through a real chat agent (claude or codex), intercepts
all traffic to your MCP server with a recording proxy, and validates the observed tool
calls against your expectations — with a live terminal UI and a self-contained HTML
report.

## Install

```sh
npm install -g @bitmcp-eval/cli
# or run without installing:
npx @bitmcp-eval/cli -c eval.yaml
```

Requires Node.js ≥ 20 and an installed, authenticated agent CLI
([Claude Code](https://claude.com/claude-code) or
[OpenAI Codex](https://github.com/openai/codex)).

## Usage

```sh
bitmcp-eval -c eval.yaml           # run the evaluation
bitmcp-eval -c eval.yaml -i 10     # override iterations
bitmcp-eval login -c eval.yaml     # pre-authorize an OAuth-protected MCP server
```

See the [full documentation](https://github.com/bitmovin/bitmcp-eval#readme) for test
case format, configuration reference, OAuth handling, and the optional LLM judge —
or the [project page](https://bitmovin.github.io/bitmcp-eval/) for an animated demo.

## License

[MIT](LICENSE) © Bitmovin, Inc.
