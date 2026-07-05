import React, {useState, useEffect, useRef} from 'react';
import {Box, Text, Static, Spacer} from 'ink';
import {Spinner, ProgressBar} from '@inkjs/ui';
import { parseConfig, Config } from '@bitmcp_eval/common/config';
import { runClaude } from '@bitmcp_eval/common/agents';
import { loadTestCases, TestCase } from '@bitmcp_eval/common/testCases';
import Header from './header.js'
import ConfigPrinter from './config_printer.js';
import TestCasesLoader from './test_cases_loader.js';
import { appendFileSync } from 'node:fs';
import { McpRecordingProxy} from '@bitmcp_eval/common/mcp_recording';

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


type TestCounterProps = {
  totalTests: number,
  testsDone : number
};
function TestCounter({totalTests, testsDone} : TestCounterProps) {
  if (totalTests == 0) return null;
  const value = (testsDone / totalTests) * 100;
  return (
    <Box flexDirection='column'>
      <Box height={1}/>
      <Box>
        <ProgressBar value={value} />
        <Text> {testsDone}/{totalTests} Tests completed</Text>
        
        
        
      </Box>
      <Box height={1}/>
    </Box>
  );
}


type ProxyStateProps = {
  proxyUrl : string | null,
  mcpUrl : string | null,
};
function ProxyStateRenderer({proxyUrl, mcpUrl} : ProxyStateProps ) {
  if (proxyUrl) 
    return (
          <Box flexDirection='column'>
            <Box height= {1}/>
            <Box>
              <Text>MCP Recorder Proxy up!</Text>
              <Text color="blue"> {proxyUrl} </Text>
              <Text> {`->`}</Text>
              <Text color="green"> {mcpUrl}</Text>
            </Box>
            <Box height= {1}/>
        </Box>

    )
  else
    return <Spinner label="MCP Recorder Proxy starting..."/>
}

function renderOverallState(config : Config | null, testCases : TestCase[], 
        currentTest : TestCase | null, 
        currentClaudeResult : string | null,
        proxyUrl : string | null,
        mcpUrl : string | null, 
        testsDone : number | 0) {

  if (!config) return null;

 

  const currentTestElement = currentTest ? renderCurrentTest(currentTest) : (<></>);

  const currentClaudeResultElement = currentClaudeResult ? renderClaudeResult(currentClaudeResult) : (<Spinner label="test running.."/>);
    
  return (
   <>
    
    <Box flexDirection="column">
      <Header title="MCP Evaluation Run"/>
      <Spacer/>
      <ConfigPrinter config={config}/>
      <TestCasesLoader testCases={testCases}/>
      <ProxyStateRenderer proxyUrl={proxyUrl} mcpUrl={mcpUrl}/>
      <TestCounter totalTests={testCases?.length} testsDone={testsDone}/>
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
  const proxyRef = useRef<McpRecordingProxy | null>(null);
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const [testsDone, setTestsDone] = useState<number>(0);

  // TODO read mcp url from config! 
  // For now we just hardcode it
  const mcpUrl = useRef<string>("http://localhost:3210/mcp");

  useEffect(() => {
    

    setConfig(parseConfig());
  }, []); 

  // The recording proxy gets created once, for the app's lifetime
  useEffect(() => {
    let cancelled = false;
    const proxy = new McpRecordingProxy({ targetUrl: mcpUrl.current });

    proxy.start().then(({ url }) => {
      if (cancelled) return;      // unmounted mid-start
      proxyRef.current = proxy;
      setProxyUrl(url);           // re-render so children know it's up
    });

    return () => {
      cancelled = true;
      void proxy.stop();          // idempotent; releases the port + event loop
    };
}, []);  

  useEffect(() => {
    if (!config) return;
    prepareTestCases(setTestCases, config);
   
  }, [config]);

  useEffect(() => {
    if (!proxyUrl) return;
    appendFileSync('debug_app.log', 'in useEffect of testcase walker');


    (async () => {
      for (const tc of testCases) {
        try { 
          appendFileSync('debug_app.log', 'setting testcase');
          setCurrentTest(tc);

          const response = await runClaude(tc.prompt, proxyUrl);
          setClaudeResult(response); 
          setTestsDone(prev => prev + 1);
        } catch (err: any) {
          setError(err);
          break;
        }
    }
    })();
    

  }, [testCases, proxyUrl]);


  if (error) {
    return <Text color="red">Failed: {error.message}</Text>;
  }
 
  return renderOverallState(config, testCases, currentTest, claudeResult, 
      proxyUrl, mcpUrl.current,
      testsDone);

};

