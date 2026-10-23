'use strict';
// Windows Codex Desktop IPC adapter; no dependencies or additional app-server.
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');

function compactThread(threadId, idleConfirmed) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId ?? '')) {
    return Promise.reject(new Error('thread_id must be a real Codex thread UUID.'));
  }
  if (idleConfirmed !== true) return Promise.reject(new Error('Confirm the target is idle using wait_threads before compacting.'));
  if (process.platform !== 'win32') return Promise.reject(new Error('This adapter requires Windows Codex Desktop.'));
  return new Promise((resolve, reject) => {
    const socket = net.connect('\\\\.\\pipe\\codex-ipc');
    let buffer = Buffer.alloc(0), clientId = 'initializing-client', pendingId;
    let submitted = false, settled = false;
    const timer = setTimeout(() => finish(new Error(submitted
      ? 'Outcome unknown after submission. Inspect the target with read_thread; do not blindly retry.'
      : 'Desktop IPC connection timed out.')), 15000);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(result);
    }
    function send(method, params, version, hostId) {
      pendingId = randomUUID();
      const body = Buffer.from(JSON.stringify({type:'request', requestId:pendingId,
        sourceClientId:clientId, method, params, version, ...(hostId ? {hostId} : {})}));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    }
    socket.on('connect', () => send('initialize', {clientType:'desktop-compact-tool'}, 0));
    socket.on('error', error => finish(new Error(submitted
      ? `Outcome unknown: ${error.message}. Inspect target before retrying.` : error.message)));
    socket.on('close', () => { if (!settled) finish(new Error('Desktop IPC closed; inspect target before retrying.')); });
    socket.on('data', data => {
      try {
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 4) {
          const size = buffer.readUInt32LE(0);
          if (!size || size > 268435456) throw new Error('Invalid Desktop IPC frame.');
          if (buffer.length < 4 + size) break;
          const message = JSON.parse(buffer.subarray(4, 4 + size));
          buffer = buffer.subarray(4 + size);
          if (message.type !== 'response' || message.requestId !== pendingId) continue;
          if (message.resultType !== 'success') throw new Error(message.error || 'Desktop rejected request.');
          if (message.method === 'initialize') {
            clientId = message.result.clientId;
            submitted = true;
            send('thread-follower-compact-thread', {conversationId:threadId}, 2, 'local');
          } else {
            if (message.method !== 'thread-follower-compact-thread' || message.result?.ok !== true) {
              throw new Error('Unexpected compact acknowledgement; inspect target before retrying.');
            }
            finish(null, {thread_id:threadId, host_id:'local', status:'started',
              next:'Wait with wait_threads, then confirm a completed turn containing contextCompaction via read_thread. This acknowledgement is not completion.'});
          }
        }
      } catch (error) { finish(error); }
    });
  });
}

const tool = {
  name:'compact_thread',
  description:'Start context compaction for one specified local Windows Codex Desktop chat. Requires user authorization and an idle target confirmed using wait_threads. Does not send a prompt, fork, or start another app-server. Asynchronous: verify completion using wait_threads/read_thread; never blindly retry an unknown outcome.',
  inputSchema:{type:'object', properties:{thread_id:{type:'string',description:'Exact target Codex thread UUID.'},
    idle_confirmed:{type:'boolean',const:true,description:'Set true only after confirming the target has no active turn.'}},
    required:['thread_id','idle_confirmed'], additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
};
async function handle(request) {
  if (request.id === undefined) return;
  const reply = result => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
  switch(request.method) {
    case 'initialize': return reply({protocolVersion:request.params?.protocolVersion ?? '2024-11-05',
      capabilities:{tools:{}},serverInfo:{name:'desktop-compact',version:'1.0.0'}});
    case 'ping': return reply({});
    case 'tools/list': return reply({tools:[tool]});
    case 'tools/call': {
      try {
        if (request.params?.name !== tool.name) throw new Error('Unknown tool.');
        const args = request.params.arguments ?? {};
        if (Object.keys(args).some(key => !['thread_id','idle_confirmed'].includes(key))) throw new Error('Unexpected arguments.');
        const result = await compactThread(args.thread_id, args.idle_confirmed);
        return reply({content:[{type:'text',text:JSON.stringify(result)}]});
      } catch(error) { return reply({isError:true,content:[{type:'text',text:error.message}]}); }
    }
    default: process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}})+'\n');
  }
}
if (process.argv[2] === '--thread-id') {
  compactThread(process.argv[3], process.argv[4] === '--idle-confirmed').then(
    result => console.log(JSON.stringify(result)),
    error => {console.error(error.message);process.exitCode=1;});
} else {
  readline.createInterface({input:process.stdin}).on('line', line => {
    try { void handle(JSON.parse(line)).catch(error => console.error(error.message)); }
    catch { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n'); }
  });
}
