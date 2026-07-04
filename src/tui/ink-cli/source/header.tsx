import React, {useState, useEffect} from 'react';
import {Box, Text} from 'ink';


type Props = {
    title: string,
};

export default function Header( {title} : Props) {

    return (
        <Box borderStyle="single" paddingLeft={1}>
            <Text bold italic color="blueBright">{title}</Text>
        </Box>
    )
}
