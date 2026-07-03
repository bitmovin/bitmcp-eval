import { execFile } from 'node:child_process';
import { promisify } from 'node:util';


const execFileAsync = promisify(execFile);

export async function runClaude(prompt) {
  const { stdout } = await execFileAsync('claude', ['-p', prompt]);
  return stdout;

};
