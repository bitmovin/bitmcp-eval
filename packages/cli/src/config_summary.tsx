import React from 'react';
import { Box, Text } from 'ink';
import type { EvalConfig } from '@bitmcp-eval/core';

/** Compact overview of the effective run configuration. Header values are never printed. */
export default function ConfigSummary({ config }: { config: EvalConfig }) {
  return (
    <Box flexDirection="column" marginY={1}>
      <Text>
        <Text bold>MCP server: </Text>
        <Text color="green">{config.mcp.url}</Text>
        {config.mcp.headers.length > 0 && (
          <Text dimColor> (+ headers: {config.mcp.headers.map((h) => h.name).join(', ')})</Text>
        )}
      </Text>
      <Text>
        <Text bold>Test cases: </Text>
        {config.testcases.path} <Text dimColor>({config.testcases.source})</Text>
      </Text>
      <Text>
        <Text bold>Run: </Text>
        agent(s) <Text color="cyan">{config.run.agents.join(', ')}</Text> · {config.run.iterations} iteration(s) per
        test case · timeout {config.run.timeoutSeconds}s
        {config.judge && (
          <Text>
            {' '}
            · judge <Text color="magenta">{config.judge.model}</Text>
          </Text>
        )}
      </Text>
    </Box>
  );
}
