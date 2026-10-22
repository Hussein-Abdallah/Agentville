// Bubble text (plan section 7): Claude's own words first, then rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyTask } from '../server/friendly';

const say = (tool_name: string, tool_input: Record<string, unknown> = {}) => friendlyTask({ tool_name, tool_input });

test('files: Read and Edit word a file the same way', () => {
  for (const [file, words] of [['src/state.ts', 'state.ts'], ['src/LoginForm.tsx', 'the login form'], ['src/user_settings.py', 'the user settings']]) {
    assert.equal(say('Read', { file_path: file }), `Reading ${words}`);
    assert.equal(say('Edit', { file_path: file }), `Editing ${words}`);
  }
  assert.equal(say('Edit', { file_path: 'package.json' }), 'Updating dependencies');
  assert.equal(say('Edit', { file_path: 'README.md' }), 'Editing the README');
});

test('commands: their own description, else a known phrase', () => {
  assert.equal(say('Bash', { command: 'npm test', description: 'Run the unit tests' }), 'Run the unit tests');
  assert.equal(say('Bash', { command: 'npm test' }), 'Running tests');
  assert.equal(say('Bash', { command: 'git commit -m x' }), 'Saving a commit');
  assert.equal(say('Bash', { command: 'some-tool --flag' }), 'Running a command');
});

test('MCP tools: their own summary, else wording for known servers', () => {
  assert.equal(say('mcp__Claude_Browser__computer', { action: 'left_click', action_summary: 'Clicks Save' }), 'Clicks Save');
  assert.equal(say('mcp__Claude_Browser__computer', { action: 'screenshot' }), 'Looking at the page');
  assert.equal(say('mcp__Claude_Browser__navigate', { url: 'http://localhost:4917/?demo' }), 'Opening localhost:4917');
  assert.equal(say('mcp__chrome-devtools__take_screenshot'), 'Looking at the page');
  assert.equal(say('mcp__terminal__run_in_terminal', { command: 'npm start' }), 'Running npm start in a terminal');
  assert.equal(say('mcp__terminal__read_terminal'), 'Reading the terminal');
  assert.equal(say('mcp__github__create_issue'), 'Using github');
  assert.equal(say('mcp__ccd_turn__wrap_up'), 'Wrapping up');
});

test('other tools', () => {
  assert.equal(say('WebFetch', { url: 'https://example.com/x' }), 'Reading example.com');
  assert.equal(say('WebSearch', { query: 'pixi zoom' }), 'Searching the web for "pixi zoom"');
  assert.equal(say('ToolSearch', { query: 'q' }), 'Loading tools');
  assert.equal(say('Agent', { description: 'Review the code' }), 'Delegating: Review the code');
});
