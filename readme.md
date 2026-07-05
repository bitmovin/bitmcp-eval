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
  * locally running chat harnesses, e.g. codex exec, claude -p
  * api basedv invocation
  * local raw model (e.g. in ollama) with a separatre chat harness wrapper like OpenCode or PI

* store testcase in multiple locations:
  * filesystem
  * S3
  * git repository

## How does it work? 

A proxy-server is started which intercepts calls from the chat-agents towards the mcp-server under test on 
transport-layer level. 
We support for now HTTP-Streaming, but local stdin/stdout is planned for the future. 

This allows us to interact with any mcp server as long as it adheres to the mcp protocol standard. 

The proxy-server intercepts any call towards the mcp server and can therefore easily inspect
* incoming arguments
* which calls are invoked
* response of the mcp server







