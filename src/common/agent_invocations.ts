import { execFile } from 'node:child_process';
import { promisify } from 'node:util';


const execFileAsync = promisify(execFile);

export async function runClaude(prompt : string ) : Promise<string> {
  const { stdout } = await execFileAsync('claude', ['-p', prompt]);
  return stdout;

};
