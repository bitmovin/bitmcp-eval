
import {TestCase} from '@bitmcp_eval/common/testCases';
import {Box, Text} from 'ink';
import {Spinner } from '@inkjs/ui';


type Props = {
    testCases: TestCase[],
};


export default function TestCasesLoader( {testCases} : Props) {

    const testCasesElement = (testCases != null && testCases.length > 0)
  ? (
        <Box flexDirection='column'>
            <Box height={1}/>
            <Text>{testCases.length} TestCases loaded! </Text>
        </Box>
    
    )
  : (
        <Box flexDirection='column'>
            <Box height={1}/>
            <Spinner label="Loading testcases..."/> 
        </Box>
  );

  return testCasesElement;
}