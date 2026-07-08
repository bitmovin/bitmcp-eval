/**
 * A minimal StreamableHTTP MCP server used to demo bitmcp-eval.
 *
 * It exposes three deterministic weather tools so that evaluation runs
 * produce stable, reproducible results without any external API.
 *
 *   yarn workspace @bitmcp-eval/demo-mcp-server start
 *   -> http://127.0.0.1:3210/mcp
 */
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = Number(process.env.PORT ?? 3210);

const WEATHER: Record<string, { temperatureC: number; condition: string }> = {
  vienna: { temperatureC: 24, condition: 'sunny' },
  berlin: { temperatureC: 19, condition: 'cloudy' },
  london: { temperatureC: 16, condition: 'rainy' },
  denver: { temperatureC: 28, condition: 'clear' },
};

function buildServer(): McpServer {
  const server = new McpServer({ name: 'demo-weather', version: '1.0.0' });

  server.tool('list_supported_cities', 'List the cities this weather service has data for.', {}, async () => ({
    content: [{ type: 'text', text: JSON.stringify(Object.keys(WEATHER)) }],
  }));

  server.tool(
    'get_current_weather',
    'Get the current weather for a city.',
    { city: z.string().describe('City name, e.g. "Vienna"') },
    async ({ city }) => {
      const data = WEATHER[city.toLowerCase()];
      if (!data) {
        return {
          content: [{ type: 'text', text: `No data for "${city}". Use list_supported_cities to see options.` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ city, ...data }) }] };
    },
  );

  server.tool(
    'get_forecast',
    'Get a daily temperature forecast for a city.',
    {
      city: z.string().describe('City name, e.g. "Berlin"'),
      days: z.number().int().min(1).max(7).describe('Number of days to forecast'),
    },
    async ({ city, days }) => {
      const data = WEATHER[city.toLowerCase()];
      if (!data) {
        return {
          content: [{ type: 'text', text: `No data for "${city}". Use list_supported_cities to see options.` }],
          isError: true,
        };
      }
      const forecast = Array.from({ length: days }, (_, i) => ({
        day: i + 1,
        temperatureC: data.temperatureC + ((i * 3) % 5) - 2,
        condition: data.condition,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ city, forecast }) }] };
    },
  );

  return server;
}

const app = express();
app.use(express.json());

// Stateless mode: a fresh server + transport per request, no session tracking.
app.post('/mcp', async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed: this demo server is stateless and does not offer SSE' },
    id: null,
  });
});

app.listen(PORT, () => {
  console.log(`demo-weather MCP server listening on http://127.0.0.1:${PORT}/mcp`);
});
