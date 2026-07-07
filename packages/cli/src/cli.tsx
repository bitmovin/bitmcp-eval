#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import App from './app.js';

const cli = meow(
  `
  Usage
    $ bitmcp-eval [options]

  Options
    --config, -c      Path to the eval config YAML (default: ./eval.yaml)
    --iterations, -i  Override run.iterations from the config
    --debug           Log every proxied request's headers and tools to
                      <report.outDir>/bitmcp-eval-debug.log (contains secrets!)

  Examples
    $ bitmcp-eval --config examples/eval.yaml
    $ bitmcp-eval -c my-eval.yaml -i 5
`,
  {
    importMeta: import.meta,
    flags: {
      config: { type: 'string', shortFlag: 'c', default: './eval.yaml' },
      iterations: { type: 'number', shortFlag: 'i' },
      debug: { type: 'boolean', default: false },
    },
  },
);

render(<App configPath={cli.flags.config} iterationsOverride={cli.flags.iterations} debug={cli.flags.debug} />);
