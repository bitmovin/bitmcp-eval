import { homedir } from 'node:os';
import { readFileSync, appendFileSync } from 'node:fs';
import { readdir} from 'node:fs/promises';
import YAML from 'yaml';

export type TestCase = {
    prompt: string,
    expectedTools: string[],

};

// For testing/simulating wait time and see if the correct spinners are rendered etc.
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function debugLog(msg : string) {
        appendFileSync('debug_app.log', `\n${msg}`);
    
}

export async function loadTestCases(path: string) : Promise<TestCase[]> {
        appendFileSync('debug_app.log', `\npath for testcases: ${path}\n`);
        
        var testCases : Array<TestCase> = [];
        const files = (await readdir(expandHome(path))).filter(f => f.endsWith(".yaml"));
        for (const f of files) {
            try {
                const fullPath = path + "/" + f;
                const fileContent = readFileSync(expandHome(fullPath), 'utf8');
                const tc = YAML.parse(fileContent);
                debugLog(`testprompt: ${tc.prompt}`);
                testCases.push(tc);
            } catch (err : any) {
                if (err instanceof Error) {
                    throw err;
                }
                throw new Error(`Could not read testcase file at ${path}/${f}`);
            }
        }
    
        return Promise.resolve(testCases);
    
}

function expandHome(p : string) : string { 
  return p.startsWith('~') ? p.replace(/^~/, homedir()): p;
}


