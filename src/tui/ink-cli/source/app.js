import React, {useState, useEffect} from 'react';
import {Box, Text, Static} from 'ink';
import {Spinner, ProgressBar} from '@inkjs/ui';
import { parseConfig } from '@bitmcp_eval/common';
import { runClaude } from '@bitmcp_eval/common/agents';


function renderOverallState(config, tests) {
  if (!tests || tests.length == 0) return; 
  let lastTest = tests[tests.length-1]; 

  return (
   <>
    <Box key={lastTest.id} flexDirection="column">
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


export default function App({name = 'Stranger'}) {

  const [config, setConfig] = useState(null);
  const [tests, setTests] = useState([]);
  const [error, setError] = useState(null);
  const [claudeResult, setClaudeResult] = useState(null);

  useEffect(() => {
    setConfig(parseConfig());
  }, []); 

  useEffect(() => {
    let completedTests = 0;
    let timer;
   
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
        const out = await runClaude('haskell advantages, short summary');
        setClaudeResult(out);
        
      } catch(err) {
        setError(err);
      }
     })();   

  }, [config]);


   if (error) {
    return <Text color="red">Failed: {error.message}</Text>;
   }
 


  return renderOverallState(config, tests);


};

