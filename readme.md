# bitmcp_eval

This program lets you evaluate the interaction of your mcp server with 
llm agents. 

## Main features:

* formulate testcases which contain
* the prompt
* expected tool invocations
* expected tool arguments
* exptected tone of the response

* execute multiple evaluation runs against your mcp server, which can run locally or remote

* use llm chat agents:
** locally running chat harnesses, e.g. codex exec, claude -p
** api basedv invocation
** local raw model (e.g. in ollama) with a separatre chat harness wrapper like OpenCode or PI

* store testcase in multiple locations:
** filesystem
** S3
** git repository





