import {Box, Spacer, Text} from 'ink';
import {Config} from '@bitmcp_eval/common/config';


type Props = {
    config: Config,
};

export default function ConfigPrinter( {config} : Props) {

    return (
        <Box borderStyle="single" paddingLeft={1} flexDirection="column">
            <Box>
                <Text bold >Testcases location: </Text>
                <Text italic >{config.testcases.url} </Text>
                <Spacer />
                <Text dimColor>({config.testcases.source})</Text>
            </Box>
        </Box>
    )
}
