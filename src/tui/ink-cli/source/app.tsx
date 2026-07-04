import React, {useState, useEffect} from 'react';
import {Box, Text, Static, Spacer} from 'ink';
import {Spinner, ProgressBar} from '@inkjs/ui';
import { parseConfig, Config } from '@bitmcp_eval/common/config';
import { runClaude } from '@bitmcp_eval/common/agents';
import { loadTestCases, TestCase } from '@bitmcp_eval/common/testCases';
import Header from './header.js'
import ConfigPrinter from './config_printer.js';
import { appendFileSync } from 'node:fs';

function renderCurrentTest(currentTest : TestCase) {
 
  return (
    <Text>Test: {currentTest.prompt}</Text>
  )
}

function renderClaudeResult(claudeResult : string) {
  return (
    <Text>Result: {claudeResult}</Text>
  )
}

function renderOverallState(config : Config | null, testCases : TestCase[], 
        currentTest : TestCase | null, 
        currentClaudeResult : string | null) {

  if (!config) return null;

  const testCasesElement = (testCases != null && testCases.length > 0)
  ? (<Text>{testCases.length} TestCases loaded! </Text>)
  : (
    <Spinner label="Loading testcases..."/> 
  );

  const currentTestElement = currentTest ? renderCurrentTest(currentTest) : (<></>);

  const currentClaudeResultElement = currentClaudeResult ? renderClaudeResult(currentClaudeResult) : (<Spinner label="test running.."/>);
    
  return (
   <>
    
    <Box flexDirection="column">
      <Header title="MCP Evaluation Run"/>
      <Spacer/>
      <ConfigPrinter config={config}/>
      {testCasesElement}
      {currentTestElement}
      {currentClaudeResultElement}

    </Box>
   
 </>
  )
}

function prepareTestCases(setTestCases : (tcs : TestCase[]) => void, config : Config) {
  appendFileSync('debug_app.log', 'in preapreTestCases');
  
  async function run()  {
    appendFileSync('debug_app.log', 'in run1');
    let testCases = await loadTestCases(config.testcases.url);
    setTestCases(testCases);
  }
  run();
}


export default function App() {

  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [claudeResult, setClaudeResult] = useState<string | null>(null);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [currentTest, setCurrentTest] = useState<TestCase | null>(null);

  useEffect(() => {
    setConfig(parseConfig());
  }, []); 

  useEffect(() => {
    if (!config) return;
    prepareTestCases(setTestCases, config);
  }, [config]);

  useEffect(() => {
    appendFileSync('debug_app.log', 'in useEffect of testcase walker');
    for (const tc of testCases) {
      appendFileSync('debug_app.log', 'setting testcase');
      setCurrentTest(tc);

      (async() => {
        try { 
          const out : string = await runClaude(tc.prompt);
          setClaudeResult(out);
          
        } catch(err : any) {
          setError(err);
        }
      })();
    }

  }, [testCases]);


   if (error) {
    return <Text color="red">Failed: {error.message}</Text>;
   }
 


  return renderOverallState(config, testCases, currentTest, claudeResult);


};

