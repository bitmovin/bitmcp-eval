
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

export function loadConfig(path) {
  let text;
  try {
    text = readFileSync(expandHome(path), 'utf8');
  } catch (err) {
    throw new Error(`Config file not found at ${path}`);
  }

  try {
    return YAML.parse(text);
  } catch (err) {
    throw new Error(`Config file at ${path} is not valid YAML: ${err.message}`);
  }
}

function expandHome(p) { 
  return p.startsWith('~') ? p.replace(/^~/, homedir()): p;
}

export function parseConfig() {
  var config = loadConfig("~/eval.yaml");
  return config;
};

export function runStartup() {
  console.log("startup...");
  var config = loadConfig("~/eval.yaml");
  console.log("source: " + config.testcases.source);
  
};
