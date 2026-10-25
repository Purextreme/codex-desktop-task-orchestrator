'use strict';
// Read-only admission advisor. No Codex IPC, network, media reads or task execution.
const fs = require('node:fs');

const STATES = new Set(['queued', 'starting', 'running', 'compacting', 'waiting_external',
  'waiting_user', 'done', 'failed', 'unknown', 'superseded']);
const EXTERNAL = new Set(['none', 'pending', 'unknown', 'settled']);
const ACTIVE = new Set(['starting', 'running', 'compacting', 'unknown']);
const TERMINAL = new Set(['done', 'failed', 'superseded']);

function check(ok, message) { if (!ok) throw new Error(message); }
function integer(value, min, field) {
  check(Number.isSafeInteger(value) && value >= min, `${field} must be an integer >= ${min}`);
}
function string(value, field) { check(typeof value === 'string' && value.trim(), `${field} is required`); }
function bool(value, field) { check(typeof value === 'boolean', `${field} must be boolean`); }
function timestamp(value, field) {
  check(typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value), `${field} must include a timezone`);
  const time = Date.parse(value);
  check(Number.isFinite(time), `${field} must be a valid timestamp`);
  return time;
}
function strings(value, field) {
  check(Array.isArray(value) && value.every(v => typeof v === 'string' && v.trim()), `${field} must be a string array`);
  check(new Set(value).size === value.length, `${field} must not contain duplicates`);
}
function safeExternal(task) { return ['none', 'settled'].includes(task.external_state); }
function safeTerminal(task) { return TERMINAL.has(task.state) && task.idle_confirmed && safeExternal(task); }
function occupies(task) {
  return task.state !== 'queued' && (!task.idle_confirmed || ACTIVE.has(task.state) || task.external_state === 'unknown');
}

function planDispatch(state, caller, now = Date.now()) {
  check(state && state.schema_version === 1, 'Unsupported schema_version');
  string(state.workflow_id, 'workflow_id');
  string(state.owner_thread_id, 'owner_thread_id');
  integer(state.generation, 1, 'generation');
  check(['active', 'draining', 'standby'].includes(state.phase), 'Invalid phase');
  const observed = timestamp(state.observed_at, 'observed_at');
  integer(state.total_limit, 2, 'total_limit');
  integer(state.worker_limit, 1, 'worker_limit');
  check(state.worker_limit < state.total_limit, 'Reserve at least one coordinator slot');
  integer(state.other_active, 0, 'other_active');
  bool(state.monitor_active, 'monitor_active');
  if (state.handoff_reserved !== undefined) bool(state.handoff_reserved, 'handoff_reserved');
  check(['ok', 'degraded', 'unknown'].includes(state.control_health), 'Invalid control_health');
  bool(state.congestion, 'congestion');
  integer(state.healthy_rounds, 0, 'healthy_rounds');
  check(caller && typeof caller.thread_id === 'string', 'Caller thread_id is required');
  integer(caller.generation, 1, 'caller generation');
  check(Number.isFinite(now), 'Invalid current time');
  check(Array.isArray(state.tasks) && state.tasks.length <= 1000, 'tasks must be an array of at most 1000 entries');

  const ids = new Map();
  for (const task of state.tasks) {
    check(task && typeof task === 'object', 'Invalid task');
    string(task.id, 'task.id');
    check(!ids.has(task.id), 'Duplicate logical task id');
    check(STATES.has(task.state), 'Invalid task state');
    check(EXTERNAL.has(task.external_state), 'Invalid external_state');
    bool(task.idle_confirmed, 'task.idle_confirmed');
    bool(task.ready, 'task.ready');
    if (task.thread_id != null) string(task.thread_id, 'task.thread_id');
    strings(task.depends_on, 'task.depends_on');
    strings(task.resources, 'task.resources');
    check(task.state !== 'queued' || safeExternal(task), 'Queued task has an unresolved external request');
    check(task.state !== 'queued' || task.idle_confirmed, 'Queued task must have no active turn');
    if (task.last_progress_at !== undefined) timestamp(task.last_progress_at, 'task.last_progress_at');
    if (task.expected_progress_seconds !== undefined) integer(task.expected_progress_seconds, 1, 'task.expected_progress_seconds');
    if (task.role === 'standby') integer(task.target_generation, 2, 'task.target_generation');
    ids.set(task.id, task);
  }
  if (state.successor_task_id != null) {
    string(state.successor_task_id, 'successor_task_id');
    check(ids.has(state.successor_task_id), 'Unknown successor_task_id');
  }
  // Reject missing dependencies and cycles instead of silently queueing forever.
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    check(ids.has(id), 'Unknown dependency');
    check(!visiting.has(id), 'Dependency cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of ids.get(id).depends_on) visit(dep);
    visiting.delete(id); visited.add(id);
  }
  for (const id of ids.keys()) visit(id);

  const holds = [];
  if (caller.thread_id !== state.owner_thread_id) holds.push('wrong_owner');
  if (caller.generation !== state.generation) holds.push('generation_mismatch');
  if (state.phase !== 'active') holds.push('handoff_in_progress');
  if (now - observed > 120000 || observed - now > 5000) holds.push('snapshot_stale_or_clock_skew');
  if (state.control_health !== 'ok') holds.push('control_unhealthy');
  if (state.congestion) holds.push('congestion_backoff');

  const workers = state.tasks.filter(occupies).length;
  const occupancy = 1 + Number(state.monitor_active) + state.other_active + workers;
  const slots = Math.max(0, Math.min(state.worker_limit - workers, state.total_limit - occupancy));
  // A draining owner may reserve one read-only successor; business stays stopped.
  const handoffGate = state.phase === 'draining' && slots > 0
    && holds.length === 1 && holds[0] === 'handoff_in_progress';
  const existingSuccessor = state.tasks.some(task => task.role === 'standby'
    && task.target_generation === state.generation + 1 && (task.thread_id || !safeTerminal(task)));
  const handoffAllowed = handoffGate && !state.handoff_reserved
    && state.successor_task_id == null && !existingSuccessor;
  const successor = ids.get(state.successor_task_id);
  const handoffRecheck = handoffGate && state.handoff_reserved && successor?.role === 'standby'
    && successor.target_generation === state.generation + 1 && ['done', 'failed'].includes(successor.state)
    && safeTerminal(successor) && typeof successor.thread_id === 'string' && successor.thread_id.trim()
    ? successor.id : null;
  const reserved = new Set(state.tasks
    .filter(task => task.state !== 'queued' && !safeTerminal(task))
    .flatMap(task => task.resources));
  const dispatch = [], waiting = [], alerts = [];

  for (const task of state.tasks) {
    if (task.state === 'unknown' || task.external_state === 'unknown') {
      alerts.push({id: task.id, reason: 'outcome_unknown', action: 'inspect_original_request'});
    } else if (task.state === 'waiting_user') {
      alerts.push({id: task.id, reason: 'needs_user', action: 'surface_existing_question'});
    } else if (task.state === 'failed') {
      alerts.push({id: task.id, reason: 'failed', action: 'review_before_recovery'});
    } else if (occupies(task) || task.state === 'waiting_external') {
      if (task.last_progress_at !== undefined && now - timestamp(task.last_progress_at, 'task.last_progress_at')
        > (task.expected_progress_seconds ?? 300) * 1000) {
        alerts.push({id: task.id, reason: 'progress_overdue', action: 'inspect_without_interrupting'});
      }
    }
    if (task.state !== 'queued') continue;
    let reason;
    if (!task.ready) reason = 'input_or_authorization_unverified';
    else if (!task.depends_on.every(id => ids.get(id).state === 'done' && safeTerminal(ids.get(id)))) reason = 'dependency';
    else if (task.resources.some(resource => reserved.has(resource))) reason = 'resource_busy';
    else if (holds.length) reason = 'dispatch_held';
    else if (dispatch.length >= slots) reason = 'capacity';
    if (reason) waiting.push({id: task.id, reason});
    else {
      dispatch.push(task.id);
      for (const resource of task.resources) reserved.add(resource);
    }
  }
  let nextLimit = state.worker_limit;
  if (state.congestion) nextLimit = Math.max(1, Math.floor(nextLimit / 2));
  else if (!holds.length && state.healthy_rounds >= 3) nextLimit = Math.min(state.total_limit - 1, nextLimit + 1);
  return {workflow_id: state.workflow_id, generation: state.generation, holds,
    occupancy, active_workers: workers, available_slots: holds.length ? 0 : slots,
    handoff_allowed: handoffAllowed,
    handoff_recheck: handoffRecheck,
    next_worker_limit: nextLimit, dispatch, waiting, alerts};
}

if (require.main === module) {
  try {
    const [file, owner, generation, ...extra] = process.argv.slice(2);
    check(file && owner && generation && extra.length === 0,
      'Usage: node plan-dispatch.cjs <state.json> <caller-thread-id> <generation>');
    check(fs.statSync(file).size <= 262144, 'Control file exceeds 256 KiB; retain current state only');
    const state = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const plan = planDispatch(state, {thread_id: owner, generation: Number(generation)});
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`No dispatch: ${error.message}\n`);
    process.exitCode = 1;
  }
}
module.exports = {planDispatch};
