'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {planDispatch} = require('../scripts/plan-dispatch.cjs');
const NOW = Date.parse('2026-01-01T12:00:00Z');
const caller = {thread_id: 'owner-a', generation: 1};
const task = (id, extra = {}) => ({id, state: 'queued', ready: true, idle_confirmed: true,
  external_state: 'none', depends_on: [], resources: [], ...extra});
const snapshot = (extra = {}) => ({schema_version: 1, workflow_id: 'fixture', owner_thread_id: 'owner-a',
  generation: 1, phase: 'active', observed_at: new Date(NOW).toISOString(), total_limit: 4,
  worker_limit: 3, other_active: 0, monitor_active: false, control_health: 'ok',
  congestion: false, healthy_rounds: 0, tasks: [task('a'), task('b'), task('c'), task('d')], ...extra});
const healthy = (state, now = NOW) => ({schema_version: 1, workflow_id: state.workflow_id,
  owner_thread_id: state.owner_thread_id, generation: state.generation, sampled_at: new Date(now).toISOString(),
  scope: [...new Set([state.owner_thread_id, ...state.tasks.map(t => t.thread_id).filter(Boolean)])],
  control: {status: 'ok'}, sources: {errors: []},
  threads: [...new Set([state.owner_thread_id, ...state.tasks.map(t => t.thread_id).filter(Boolean)])]
    .map(thread_id => ({thread_id, level: 'unknown', last_http_bytes: null}))});
const plan = state => planDispatch(state, caller, NOW, healthy(state));

test('bounded queue reserves one coordinator slot', () => {
  const result = plan(snapshot());
  assert.deepEqual(result.dispatch, ['a', 'b', 'c']);
  assert.deepEqual(result.waiting, [{id: 'd', reason: 'capacity'}]);
});
test('monitor and unrelated activity consume the same budget', () => {
  assert.deepEqual(plan(snapshot({monitor_active: true})).dispatch, ['a', 'b']);
  assert.deepEqual(plan(snapshot({monitor_active: true, other_active: 1})).dispatch, ['a']);
  assert.deepEqual(plan(snapshot({other_active: 4})).dispatch, []);
});
test('creation with unknown outcome remains occupied and keeps resource', () => {
  const state = snapshot({tasks: [task('old', {state: 'unknown', idle_confirmed: false, resources: ['app:x']}),
    task('new', {resources: ['app:x']}), task('other'), task('last')]});
  const result = plan(state);
  assert.deepEqual(result.dispatch, ['other', 'last']);
  assert.equal(result.active_workers, 1);
  assert.equal(result.waiting[0].reason, 'resource_busy');
  assert.equal(result.alerts[0].action, 'inspect_original_request');
});
test('external waiting releases model slot only when idle, retaining resources', () => {
  const state = snapshot({tasks: [task('render', {state: 'waiting_external', external_state: 'pending',
    resources: ['provider:job']}), task('duplicate', {resources: ['provider:job']}), task('a'), task('b'), task('c')]});
  assert.deepEqual(plan(state).dispatch, ['a', 'b', 'c']);
  state.tasks[0].idle_confirmed = false;
  assert.deepEqual(plan(state).dispatch, ['a', 'b']);
});
test('done does not override unresolved external state or unconfirmed idle', () => {
  for (const extra of [{external_state: 'unknown'}, {idle_confirmed: false}]) {
    const state = snapshot({tasks: [task('upstream', {state: 'done', ...extra}),
      task('next', {depends_on: ['upstream']})]});
    assert.deepEqual(plan(state).dispatch, []);
    assert.equal(plan(state).active_workers, 1);
  }
});
test('dependencies, verified input and per-batch resources gate admission', () => {
  const state = snapshot({tasks: [task('done', {state: 'done'}),
    task('unverified', {ready: false}), task('a', {resources: ['app:blender'], depends_on: ['done']}),
    task('b', {resources: ['app:blender']}), task('after-a', {depends_on: ['a']})]});
  const result = plan(state);
  assert.deepEqual(result.dispatch, ['a']);
  assert.deepEqual(result.waiting.map(t => t.reason), ['input_or_authorization_unverified', 'resource_busy', 'dependency']);
});
test('compaction occupies capacity; failed task is never automatically retried', () => {
  const state = snapshot({tasks: [task('compact', {state: 'compacting', idle_confirmed: false}),
    task('failed', {state: 'failed'}), task('a'), task('b'), task('c')]});
  assert.deepEqual(plan(state).dispatch, ['a', 'b']);
  assert.equal(plan(state).alerts[0].action, 'review_before_recovery');
});
test('stale, future and unreadable control snapshots do not dispatch', () => {
  for (const offset of [-120001, 5001]) {
    assert.deepEqual(plan(snapshot({observed_at: new Date(NOW + offset).toISOString()})).dispatch, []);
  }
  for (const control_health of ['unknown', 'degraded']) {
    assert.deepEqual(plan(snapshot({control_health})).dispatch, []);
  }
});
test('owner, generation and handoff phase gate every admission', () => {
  for (const extra of [{owner_thread_id: 'owner-b'}, {generation: 2}, {phase: 'draining'}, {phase: 'standby'}]) {
    assert.deepEqual(plan(snapshot(extra)).dispatch, []);
  }
});
test('successor can dispatch only after ownership commit', () => {
  const state = snapshot({phase: 'draining'}), successor = {thread_id: 'owner-b', generation: 2};
  assert.deepEqual(planDispatch(state, successor, NOW).dispatch, []);
  Object.assign(state, {owner_thread_id: 'owner-b', generation: 2, phase: 'active'});
  assert.deepEqual(plan(state).dispatch, []);
  assert.deepEqual(planDispatch(state, successor, NOW, healthy(state)).dispatch, ['a', 'b', 'c']);
});
test('draining admits one read-only successor reservation but no business', () => {
  const state = snapshot({phase: 'draining'});
  assert.deepEqual(plan(state).dispatch, []);
  assert.equal(plan(state).handoff_allowed, true);
  state.handoff_reserved = true;
  assert.equal(plan(state).handoff_allowed, false);
  for (const extra of [{owner_thread_id: 'other'}, {generation: 2}, {other_active: 3},
    {control_health: 'unknown'}, {congestion: true}]) {
    assert.equal(plan(snapshot({phase: 'draining', ...extra})).handoff_allowed, false);
  }
});
test('only the same known idle standby can recheck changed handoff text', () => {
  const state = snapshot({phase: 'draining', handoff_reserved: true, successor_task_id: 'handoff',
    tasks: [task('handoff', {role: 'standby', target_generation: 2, state: 'done', thread_id: 'owner-b'})]});
  assert.equal(plan(state).handoff_allowed, false);
  assert.equal(plan(state).handoff_recheck, 'handoff');
  assert.deepEqual(plan(state).dispatch, []);
  state.tasks[0].state = 'failed';
  assert.equal(plan(state).handoff_recheck, 'handoff');
  state.tasks[0].idle_confirmed = false;
  assert.equal(plan(state).handoff_recheck, null);
  state.tasks[0].idle_confirmed = true;
  state.tasks[0].thread_id = undefined;
  assert.equal(plan(state).handoff_recheck, null);
});
test('proven creation failure can release reservation, unknown or known successor cannot duplicate', () => {
  const state = snapshot({phase: 'draining', handoff_reserved: false, tasks: [
    task('handoff', {role: 'standby', target_generation: 2, state: 'failed'})]});
  assert.equal(plan(state).handoff_allowed, true);
  state.tasks[0].state = 'unknown';
  assert.equal(plan(state).handoff_allowed, false);
  state.tasks[0].state = 'done';
  state.tasks[0].thread_id = 'owner-b';
  assert.equal(plan(state).handoff_allowed, false);
  state.tasks[0].target_generation = 1;
  assert.throws(() => plan(state));
});
test('congestion holds new work and halves next budget, recovery is gradual', () => {
  const state = snapshot({congestion: true});
  assert.deepEqual(plan(state).dispatch, []);
  assert.equal(plan(state).next_worker_limit, 1);
  assert.equal(plan(snapshot({worker_limit: 1, healthy_rounds: 2})).next_worker_limit, 1);
  assert.equal(plan(snapshot({worker_limit: 1, healthy_rounds: 3})).next_worker_limit, 2);
  assert.equal(plan(snapshot({healthy_rounds: 3})).next_worker_limit, 3);
});
test('overdue progress only raises a read-only inspection, approval is not a stall', () => {
  const state = snapshot({tasks: [task('render', {state: 'running', idle_confirmed: false,
    last_progress_at: '2026-01-01T11:50:00Z'}), task('approval', {state: 'waiting_user',
    last_progress_at: '2026-01-01T11:00:00Z'})]});
  assert.deepEqual(plan(state).alerts, [
    {id: 'render', reason: 'progress_overdue', action: 'inspect_without_interrupting'},
    {id: 'approval', reason: 'needs_user', action: 'surface_existing_question'}]);
  state.tasks[0].expected_progress_seconds = 1800;
  assert.equal(plan(state).alerts.length, 1);
});
test('invalid dependencies, duplicate logical jobs and queued unknown effects fail closed', () => {
  for (const tasks of [
    [task('a'), task('a')], [task('a', {depends_on: ['missing']})],
    [task('a', {depends_on: ['b']}), task('b', {depends_on: ['a']})],
    [task('a', {external_state: 'unknown'})], [task('a', {idle_confirmed: false})]
  ]) assert.throws(() => plan(snapshot({tasks})));
  assert.throws(() => plan(snapshot({other_active: -1})));
  assert.throws(() => plan(snapshot({observed_at: '2026-01-01T00:00:00'})));
});
test('simulated end-to-end queue completes once per task across batches', () => {
  const state = snapshot({tasks: Array.from({length: 12}, (_, i) => task(`job-${i}`, {
    resources: [`app:${i % 3}`], depends_on: i >= 3 ? [`job-${i - 3}`] : []}))});
  const submitted = new Set();
  for (let round = 0; round < 4; round++) {
    const result = plan(state);
    assert.equal(result.dispatch.length, 3);
    for (const id of result.dispatch) {
      assert.ok(!submitted.has(id)); submitted.add(id);
      Object.assign(state.tasks.find(t => t.id === id), {state: 'starting', idle_confirmed: false});
    }
    assert.deepEqual(plan(state).dispatch, []);
    for (const id of result.dispatch) Object.assign(state.tasks.find(t => t.id === id), {state: 'done', idle_confirmed: true});
  }
  assert.equal(submitted.size, 12);
  assert.deepEqual(plan(state).dispatch, []);
});
test('CLI reads only control JSON and preserves it, with media paths treated as text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-policy-'));
  try {
    const file = path.join(dir, 'state.json');
    const input = JSON.stringify(snapshot({observed_at: new Date().toISOString(),
      selected_image: path.join(dir, 'never-created.png'), selected_video: path.join(dir, 'never-created.mp4')}));
    fs.writeFileSync(file, input, 'utf8');
    fs.writeFileSync(path.join(dir, 'health.json'), JSON.stringify(healthy(JSON.parse(input), Date.now())), 'utf8');
    const cli = path.resolve(__dirname, '../scripts/plan-dispatch.cjs');
    const result = spawnSync(process.execPath, [cli, file, 'owner-a', '1'], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).dispatch.length, 3);
    assert.equal(fs.readFileSync(file, 'utf8'), input);
    assert.deepEqual(fs.readdirSync(dir), ['health.json', 'state.json']);
    fs.writeFileSync(file, '{broken', 'utf8');
    assert.equal(spawnSync(process.execPath, [cli, file, 'owner-a', '1']).status, 1);
    fs.writeFileSync(file, ' '.repeat(262145), 'utf8');
    assert.equal(spawnSync(process.execPath, [cli, file, 'owner-a', '1']).status, 1);
  } finally {
    fs.rmSync(path.join(dir, 'state.json'), {force: true});
    fs.rmSync(path.join(dir, 'health.json'), {force: true});
    fs.rmdirSync(dir);
  }
});

test('missing, stale, unrelated or blocked monitor holds all new work', () => {
  const state = snapshot();
  const good = healthy(state);
  for (const bad of [null, {...good, sampled_at: new Date(NOW - 45001).toISOString()},
    {...good, scope: ['another-owner']}, {...good, generation: 2},
    {...good, control: {status: 'blocked'}}, {...good, sources: {errors: ['database_unavailable']}}]) {
    const result = planDispatch(state, caller, NOW, bad);
    assert.deepEqual(result.dispatch, []);
    assert.ok(result.holds.length);
    assert.equal(result.handoff_allowed, false);
  }
});

test('20 MB warns; 25 MB holds old context and allows safe parent handoff', () => {
  const state = snapshot(), health = healthy(state);
  Object.assign(health.threads[0], {level: 'warn', last_http_bytes: 20000000});
  assert.equal(planDispatch(state, caller, NOW, health).dispatch.length, 3);
  health.threads[0].last_http_bytes = 25000000;
  assert.deepEqual(planDispatch(state, caller, NOW, health).dispatch, []);
  state.phase = 'draining';
  assert.equal(planDispatch(state, caller, NOW, health).handoff_allowed, true);
  health.control.status = 'blocked';
  assert.equal(planDispatch(state, caller, NOW, health).handoff_allowed, false);
});

test('critical child never passes admission by leaving the old thread id queued', () => {
  const state = snapshot({tasks: [task('a', {thread_id: 'old'}), task('b')]});
  const health = healthy(state);
  Object.assign(health.threads.find(t => t.thread_id === 'old'), {level: 'handoff', last_http_bytes: 26000000});
  const result = planDispatch(state, caller, NOW, health);
  assert.deepEqual(result.dispatch, ['b']);
  assert.equal(result.waiting[0].reason, 'payload_handoff_required');
  assert.equal(result.handoffs[0].action, 'wait_for_safe_checkpoint');
});

test('handoffs share dependency, resource and capacity admission with ordinary jobs', () => {
  const old = task('old', {thread_id: 'old-thread', state: 'done', continue_needed: true,
    idle_confirmed_at: new Date(NOW).toISOString(), resources: ['app:blender'],
    handoff: {goal: 'Continue', authorization: 'User authorized', constraints: [], next_steps: ['Edit'],
      editable_sources: [], external_requests: [], selected_version: {status: 'selected', version: 'v1', path: 'C:/selected.png', basis: 'Selected'}}});
  const conflict = task('conflict', {resources: ['app:blender']});
  for (const tasks of [[old, conflict], [conflict, old]]) {
    const state = snapshot({tasks}), health = healthy(state);
    Object.assign(health.threads.find(t => t.thread_id === 'old-thread'), {level: 'handoff', last_http_bytes: 25000000});
    const result = planDispatch(state, caller, NOW, health);
    assert.equal(result.dispatch.length + result.handoffs.filter(h => h.can_create).length, 1);
  }
  const state = snapshot({tasks: [task('upstream', {state: 'running', idle_confirmed: false}),
    {...old, depends_on: ['upstream']}, task('other')]});
  const health = healthy(state);
  Object.assign(health.threads.find(t => t.thread_id === 'old-thread'), {level: 'handoff', last_http_bytes: 25000000});
  assert.equal(planDispatch(state, caller, NOW, health).handoffs[0].can_create, false);
  state.tasks[0].state = 'done'; state.tasks[0].idle_confirmed = true;
  state.worker_limit = 1;
  const result = planDispatch(state, caller, NOW, health);
  assert.equal(result.handoffs[0].can_create, true);
  assert.deepEqual(result.dispatch, []);
});
