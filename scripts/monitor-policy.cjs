'use strict';
// Pure policy: validates metadata and prepares text-only handoffs. No I/O or IPC.
function monitorGate(state, health, now) {
  const holds = [], alerts = [];
  const expected = [...new Set([state.owner_thread_id, ...state.tasks.map(t => t.thread_id).filter(Boolean)])].sort();
  const invalid = () => ({holds: ['monitor_missing_or_invalid'], alerts: [], threads: new Map()});
  if (!health || health.schema_version !== 1 || !Array.isArray(health.scope)
    || !Array.isArray(health.threads) || !health.control || !health.sources
    || !Array.isArray(health.sources.errors)) return invalid();
  if (health.workflow_id !== state.workflow_id || health.owner_thread_id !== state.owner_thread_id
    || health.generation !== state.generation
    || JSON.stringify([...health.scope].sort()) !== JSON.stringify(expected)) return invalid();
  const sampled = Date.parse(health.sampled_at);
  if (!Number.isFinite(sampled) || now - sampled > 45000 || sampled - now > 5000) holds.push('monitor_stale');
  if (!['ok', 'unknown', 'blocked'].includes(health.control.status)) return invalid();
  if (health.control.status !== 'ok') holds.push(`monitor_control_${health.control.status}`);
  if (health.sources.errors.length) holds.push('monitor_source_unavailable');
  const threads = new Map();
  for (const row of health.threads) {
    if (!row || !expected.includes(row.thread_id) || threads.has(row.thread_id)
      || !['unknown', 'normal', 'warn', 'handoff'].includes(row.level)) return invalid();
    if (row.last_http_bytes !== null && (!Number.isSafeInteger(row.last_http_bytes) || row.last_http_bytes < 0)) return invalid();
    // Recompute the numeric floors; an inconsistent low level must not bypass the guard.
    const level = row.level === 'handoff' || row.last_http_bytes >= 25000000 ? 'handoff'
      : row.last_http_bytes >= 20000000 ? 'warn' : row.level;
    threads.set(row.thread_id, {...row, level});
    if (['warn', 'handoff'].includes(level)) alerts.push({thread_id: row.thread_id,
      reason: level === 'handoff' ? 'payload_handoff_required' : 'payload_20mb_warning',
      last_http_bytes: row.last_http_bytes,
      peak_http_bytes: row.peak_http_bytes ?? row.last_http_bytes,
      action: level === 'handoff' ? 'handoff_at_safe_checkpoint' : 'avoid_loading_obsolete_media'});
  }
  if (threads.size !== expected.length) return invalid();
  return {holds, alerts, threads};
}

const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
const texts = value => Array.isArray(value) && value.length <= 30 && value.every(text);
const absolute = value => text(value) && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/'));

function handoffDecision(task, now) {
  const base = {id: task.id, thread_id: task.thread_id};
  const result = action => ({...base, action});
  if (task.continue_needed !== true && ['done', 'superseded'].includes(task.state)) return result('retain_finished_chat');
  if (task.state === 'waiting_user') return result('surface_existing_question');
  if (!task.ready) return result('input_or_authorization_unverified');
  const idleAt = Date.parse(task.idle_confirmed_at);
  if (!task.idle_confirmed || !Number.isFinite(idleAt) || now - idleAt > 120000 || idleAt > now + 5000
    || ['running', 'starting', 'compacting', 'unknown'].includes(task.state)) return result('wait_for_safe_checkpoint');
  if (task.external_state === 'unknown') return result('verify_original_request');
  const handoff = task.handoff;
  const selected = handoff?.selected_version;
  if (!selected || selected.status !== 'selected') return result('ask_selected_version');
  if (!text(selected.version) || !text(selected.basis)
    || !(absolute(selected.path) || !selected.path && text(selected.text))) return result('complete_handoff_text');
  if (!text(handoff.goal) || !texts(handoff.constraints) || !texts(handoff.next_steps)
    || !handoff.next_steps.length || !Array.isArray(handoff.editable_sources)
    || !handoff.editable_sources.every(absolute) || !text(handoff.authorization)) return result('complete_handoff_text');
  const requests = handoff.external_requests;
  if (!Array.isArray(requests) || requests.some(r => !text(r.id) || !text(r.status) || !text(r.query))
    || task.external_state === 'pending' && !requests.length) return result('verify_original_request');
  // Allowlist exactly what the successor needs. Drop candidates, chat excerpts and media data.
  return {...base, action: 'ready_for_fresh_chat', handoff: {
    goal: handoff.goal, constraints: handoff.constraints, next_steps: handoff.next_steps,
    authorization: handoff.authorization,
    selected_version: {version: selected.version, basis: selected.basis,
      ...(selected.path ? {path: selected.path} : {text: selected.text})},
    editable_sources: handoff.editable_sources,
    external_requests: requests.map(r => ({id: r.id, status: r.status, query: r.query})),
    external_mode: task.external_state === 'pending' ? 'query_existing_only' : 'continue_authorized_work',
    previous_thread_id: task.thread_id, logical_task_id: task.id}};
}

module.exports = {monitorGate, handoffDecision};
