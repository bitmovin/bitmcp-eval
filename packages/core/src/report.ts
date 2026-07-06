import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { EvalRunReport, IterationResult, TestCaseResult } from './runner.js';

/**
 * Writes a self-contained static HTML report for a finished run.
 * Returns the absolute path of the written file.
 */
export async function writeHtmlReport(report: EvalRunReport, outDir: string): Promise<string> {
  const dir = resolve(outDir);
  await mkdir(dir, { recursive: true });
  const fileName = `bitmcp-eval-${report.startedAt.replace(/[:.]/g, '-')}.html`;
  const path = join(dir, fileName);
  await writeFile(path, renderHtmlReport(report), 'utf8');
  return path;
}

/** Renders the full HTML document for a run report. */
export function renderHtmlReport(report: EvalRunReport): string {
  const { totals } = report;
  const passRate = totals.iterations === 0 ? 0 : totals.passedIterations / totals.iterations;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bitmcp-eval report — ${esc(formatDate(report.startedAt))}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         margin: 0; background: #f4f5f7; color: #1f2430; line-height: 1.5; }
  main { max-width: 960px; margin: 0 auto; padding: 2rem 1rem 4rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 0; }
  .muted { color: #6b7280; font-size: .875rem; }
  .summary { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1.5rem 0; }
  .stat { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: .75rem 1.25rem; min-width: 8rem; }
  .stat .value { font-size: 1.6rem; font-weight: 700; }
  .stat .label { color: #6b7280; font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; }
  .pass { color: #15803d; } .fail { color: #b91c1c; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
  .card header { display: flex; align-items: baseline; gap: .75rem; flex-wrap: wrap; }
  .badge { display: inline-block; border-radius: 999px; padding: .1rem .6rem; font-size: .75rem; font-weight: 600; }
  .badge.pass { background: #dcfce7; } .badge.fail { background: #fee2e2; }
  .prompt { font-style: italic; margin: .5rem 0; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; }
  pre { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 6px; padding: .6rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #e5e7eb; font-size: .875rem; vertical-align: top; }
  th { color: #6b7280; font-weight: 600; }
  details { margin: .25rem 0; }
  summary { cursor: pointer; font-size: .875rem; color: #374151; }
  .tools { display: flex; gap: .3rem; flex-wrap: wrap; }
  .tool { background: #eef2ff; border-radius: 4px; padding: 0 .4rem; font-size: .75rem; font-family: ui-monospace, monospace; }
  .tool.missing { background: #fee2e2; text-decoration: line-through; }
</style>
</head>
<body>
<main>
  <h1>bitmcp-eval report</h1>
  <div class="muted">
    ${esc(formatDate(report.startedAt))} &middot; agent: <code>${esc(report.agent)}</code>
    &middot; MCP server: <code>${esc(report.mcpUrl)}</code>
    &middot; ${report.iterationsPerTestCase} iteration(s) per test case
  </div>

  <div class="summary">
    <div class="stat"><div class="value">${totals.testCases}</div><div class="label">Test cases</div></div>
    <div class="stat"><div class="value">${totals.iterations}</div><div class="label">Iterations</div></div>
    <div class="stat"><div class="value pass">${totals.passedIterations}</div><div class="label">Passed</div></div>
    <div class="stat"><div class="value fail">${totals.failedIterations}</div><div class="label">Failed</div></div>
    <div class="stat"><div class="value">${Math.round(passRate * 100)}%</div><div class="label">Pass rate</div></div>
  </div>

  ${report.results.map(renderTestCase).join('\n')}
</main>
</body>
</html>
`;
}

function renderTestCase(result: TestCaseResult): string {
  const allPassed = result.iterations.every((it) => it.passed);
  return `<section class="card">
  <header>
    <h2>${esc(result.testCase.name)}</h2>
    <span class="badge ${allPassed ? 'pass' : 'fail'}">${Math.round(result.passRate * 100)}% pass</span>
    <span class="muted">${esc(result.testCase.file)}</span>
  </header>
  <p class="prompt">&ldquo;${esc(result.testCase.prompt)}&rdquo;</p>
  <div class="tools">
    expected:&nbsp;${result.testCase.expectedTools.map((t) => `<span class="tool">${esc(t)}</span>`).join(' ')}
  </div>
  <table>
    <thead><tr><th>#</th><th>Result</th><th>Tool calls</th><th>Duration</th><th>Details</th></tr></thead>
    <tbody>
      ${result.iterations.map(renderIteration).join('\n')}
    </tbody>
  </table>
</section>`;
}

function renderIteration(it: IterationResult): string {
  const badge = it.passed ? '<span class="badge pass">passed</span>' : '<span class="badge fail">failed</span>';

  const calls = it.toolCalls.length
    ? `<div class="tools">${it.toolCalls.map((c) => `<span class="tool">${esc(c.name)}</span>`).join(' ')}</div>`
    : '<span class="muted">none</span>';

  const missing = it.validation.expectations
    .filter((e) => !e.satisfied)
    .map((e) => `<span class="tool missing">${esc(e.name)} (${e.actual}/${e.expected})</span>`)
    .join(' ');

  const details: string[] = [];
  if (missing) details.push(`<div class="tools">missing:&nbsp;${missing}</div>`);
  if (it.error) details.push(`<details><summary class="fail">Error</summary><pre>${esc(it.error)}</pre></details>`);
  if (it.toolCalls.length) {
    details.push(
      `<details><summary>Recorded calls (${it.toolCalls.length})</summary>${it.toolCalls
        .map(
          (c) =>
            `<pre><b>${esc(c.name)}</b> (${c.ok ? 'ok' : 'error'}, ${Math.round(c.durationMs)} ms)\n${esc(
              JSON.stringify(c.args, null, 2) ?? 'no arguments',
            )}</pre>`,
        )
        .join('')}</details>`,
    );
  }
  if (it.turns.length > 1) {
    details.push(
      `<details><summary>Conversation (${it.turns.length} turns)</summary>${it.turns
        .map((t) => `<pre><b>user:</b> ${esc(t.message)}\n\n<b>agent:</b> ${esc(t.response ?? '(no response)')}</pre>`)
        .join('')}</details>`,
    );
  } else if (it.agentResponse) {
    details.push(`<details><summary>Agent response</summary><pre>${esc(it.agentResponse)}</pre></details>`);
  }

  return `<tr>
    <td>${it.iteration}</td>
    <td>${badge}</td>
    <td>${calls}</td>
    <td>${formatDuration(it.durationMs)}</td>
    <td>${details.join('\n') || '<span class="muted">&mdash;</span>'}</td>
  </tr>`;
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function formatDate(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** Escapes a string for safe interpolation into HTML. */
export function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
