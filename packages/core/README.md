# @bitmcp-eval/core

Core engine of [bitmcp-eval](https://github.com/bitmovin/bitmcp-eval) — an evaluation
harness that measures how LLM agents actually use an MCP server. This package contains
the recording proxy, config and test case loading, agent invocation, tool-call
validation, the optional LLM judge, and the HTML report generator.

**Most users want the CLI instead:**

```sh
npm install -g @bitmcp-eval/cli
```

Use `@bitmcp-eval/core` directly only to embed the evaluation engine in your own
tooling:

```sh
npm install @bitmcp-eval/core
```

See the [full documentation](https://github.com/bitmovin/bitmcp-eval#readme) for
concepts and configuration, or the
[project page](https://bitmovin.github.io/bitmcp-eval/) for an animated demo.

## License

[MIT](LICENSE) © Bitmovin, Inc.
