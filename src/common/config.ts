import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

type TestCaseProvider = 'filesystem' | 's3' | 'git';

export type Config = {
	testcases: {
		source: TestCaseProvider;
		url: string;
	};
    mcp_headers: {
          key : string; 
          value: string;
    }[];

};

export function loadConfig(path: string) : Config {
  let text : string;
  try {
    text = readFileSync(expandHome(path), 'utf8');
  } catch (err) {
    throw new Error(`Config file not found at ${path}`);
  }

  try {
    return YAML.parse(text);
  } catch (err : any ) {
    throw new Error(`Config file at ${path} is not valid YAML: ${
        err instanceof Error ? err.message : String(err)}`);
  }
}

function expandHome(p : string) : string { 
  return p.startsWith('~') ? p.replace(/^~/, homedir()): p;
}

export function parseConfig() : Config {
  return loadConfig("~/eval.yaml");
}

