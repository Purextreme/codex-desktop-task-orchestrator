'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {handoffDecision} = require('../scripts/monitor-policy.cjs');
const now = Date.parse('2026-01-01T12:00:00Z');
function fixture() { return {id: 'image', thread_id: 'old', state: 'done', continue_needed: true, ready: true,
  idle_confirmed: true, idle_confirmed_at: new Date(now).toISOString(), external_state: 'none',
  handoff: {goal: 'Make the selected frame into a video', authorization: 'User requested this stage',
    constraints: ['Preserve the product'], next_steps: ['Prepare video'], editable_sources: ['C:/work/source.blend'],
    external_requests: [], selected_version: {status: 'selected', version: 'v3', path: 'C:/work/chosen.png', basis: 'User selected v3'},
    candidates: ['C:/work/obsolete.png'], history: 'OLD CHAT', media_base64: 'NEVER COPY'}}; }

test('handoff contains selected version and required state only, never opens paths', () => {
  const result = handoffDecision(fixture(), now);
  assert.equal(result.action, 'ready_for_fresh_chat');
  assert.equal(result.handoff.selected_version.path, 'C:/work/chosen.png');
  assert.deepEqual(result.handoff.editable_sources, ['C:/work/source.blend']);
  for (const unwanted of ['obsolete', 'OLD CHAT', 'NEVER COPY', 'candidates']) assert.ok(!JSON.stringify(result).includes(unwanted));
});

test('active, stale idle and ambiguous selection never auto-handoff', () => {
  const task = fixture(); task.state = 'running';
  assert.equal(handoffDecision(task, now).action, 'wait_for_safe_checkpoint');
  task.state = 'done'; task.idle_confirmed_at = new Date(now - 121000).toISOString();
  assert.equal(handoffDecision(task, now).action, 'wait_for_safe_checkpoint');
  task.idle_confirmed_at = new Date(now).toISOString(); task.handoff.selected_version.status = 'ambiguous';
  assert.equal(handoffDecision(task, now).action, 'ask_selected_version');
});

test('unknown paid request blocks handoff, known pending request transfers query only', () => {
  const task = fixture(); task.external_state = 'unknown';
  assert.equal(handoffDecision(task, now).action, 'verify_original_request');
  task.external_state = 'pending';
  assert.equal(handoffDecision(task, now).action, 'verify_original_request');
  task.handoff.external_requests = [{id: 'job-123', status: 'pending', query: 'Look up job-123'}];
  const result = handoffDecision(task, now);
  assert.equal(result.handoff.external_mode, 'query_existing_only');
  assert.equal(result.handoff.external_requests[0].id, 'job-123');
});

test('completed unused chats cost no extra model turn', () => {
  const task = fixture(); task.continue_needed = false;
  assert.equal(handoffDecision(task, now).action, 'retain_finished_chat');
});

test('handoff cannot skip user approval or unverified readiness', () => {
  const task = fixture(); task.state = 'waiting_user';
  assert.equal(handoffDecision(task, now).action, 'surface_existing_question');
  task.state = 'done'; task.ready = false;
  assert.equal(handoffDecision(task, now).action, 'input_or_authorization_unverified');
});

test('clear selection with missing metadata asks the worker, not the user', () => {
  const task = fixture(); delete task.handoff.selected_version.path;
  assert.equal(handoffDecision(task, now).action, 'complete_handoff_text');
  task.handoff.selected_version.text = 'Only this selected final text is needed';
  const result = handoffDecision(task, now);
  assert.equal(result.action, 'ready_for_fresh_chat');
  assert.equal(result.handoff.selected_version.text, task.handoff.selected_version.text);
});
