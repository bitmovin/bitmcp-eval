import React, {useState, useEffect} from 'react';
import {Box, Text, Static} from 'ink';
import {Spinner, ProgressBar} from '@inkjs/ui';
import { parseConfig, Config } from '@bitmcp_eval/common/config';
import { runClaude } from '@bitmcp_eval/common/agents';

type ClaudeResult = Promise<string>

type Test = {
	id: string;
	prompt: string;
};

type Props = {
	name?: string;
};



function renderOverallState(config : Config | null, tests : Test[]) {
  if (!tests || tests.length == 0) return; 
  if (!config) return;
  let lastTest = tests[tests.length-1]; 

  return (
   <>
    
    <Box key={lastTest.id} flexDirection="column">
      <Box>
        <Text>Configuration: {config.testcases.source}</Text>
      </Box>
      <Text color="green">✔ {lastTest.id}</Text>
      <Text> {lastTest.prompt} </Text>
    </Box>
    <Box><Text>{tests.length} done, running…</Text><Spinner type="dots" /></Box>
    <Box width={30}>
      <Text>Tests: </Text><ProgressBar value={Math.round((tests.length/10) * 100)} /><Text>{tests.length/10 * 100}%</Text>
    </Box>
 </>
  )
}


export default function App() {

  const [config, setConfig] = useState<Config | null>(null);
  const [tests, setTests] = useState<Test[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [claudeResult, setClaudeResult] = useState<string | null>(null);

  useEffect(() => {
    setConfig(parseConfig());
  }, []); 

  useEffect(() => {
    let completedTests = 0;
    let timer : ReturnType<typeof setTimeout>;
   
    const run = () => {
			if (completedTests++ < 10) {
					setTests(prevTests => [
						...prevTests,
						{
							 id: "test_" + prevTests.length,
							 prompt: "my test prompt",
						},

							 ]);
									timer = setTimeout(run, 1000);
			} 
    };     
  
    run();
    return () => {
      clearTimeout(timer);
    };
 
  }, []);


  useEffect(() => {
    if (!config) return;
 
    (async () => {
      try { 
        const out : string = await runClaude('haskell advantages, short summary');
        setClaudeResult(out);
        
      } catch(err : any) {
        setError(err);
      }
     })();   

  }, [config]);


   if (error) {
    return <Text color="red">Failed: {error.message}</Text>;
   }
 


  return renderOverallState(config, tests);


};

