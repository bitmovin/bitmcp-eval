import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Spinner({ label }: { label: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text>
      <Text color="cyan">{SPINNER_FRAMES[frame]}</Text> {label}
    </Text>
  );
}

export function ProgressBar({ done, total, width = 24 }: { done: number; total: number; width?: number }) {
  const filled = total === 0 ? 0 : Math.min(width, Math.max(0, Math.round((done / total) * width)));
  return (
    <Text>
      <Text color="green">{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(width - filled)}</Text>
    </Text>
  );
}

export function Header({ title }: { title: string }) {
  return (
    <Box borderStyle="single" paddingLeft={1} paddingRight={1}>
      <Text bold color="blueBright">
        {title}
      </Text>
    </Box>
  );
}

/** Green check / red cross marks, one per finished iteration of a test case. */
export function IterationMarks({ passes }: { passes: boolean[] }) {
  return (
    <Text>
      {passes.map((passed, i) => (
        <Text key={i} color={passed ? 'green' : 'red'}>
          {passed ? '✓' : '✗'}
        </Text>
      ))}
    </Text>
  );
}
