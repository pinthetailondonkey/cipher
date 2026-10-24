import WebSocket from 'ws';

const GROUP_ID = 'd1c227a7ce5a41d7';
const RELAY = 'wss://groups.aegispayhq.com';

console.log('Connecting to', RELAY);
const ws = new WebSocket(RELAY);

ws.on('open', () => {
  console.log('✅ Connected. Sending REQs...\n');
  ws.send(JSON.stringify(['REQ', 'all', { kinds: [9002], limit: 100 }]));
  ws.send(JSON.stringify(['REQ', 'h', { kinds: [9002], '#h': [GROUP_ID] }]));
  ws.send(JSON.stringify(['REQ', 'd', { kinds: [9002], '#d': [GROUP_ID] }]));
  ws.send(JSON.stringify(['REQ', '39000', { kinds: [39000], limit: 20 }]));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg[0] === 'AUTH') console.log('🔒 AUTH requested');
  if (msg[0] === 'NOTICE') console.log('⚠️ NOTICE:', msg[1]);
  if (msg[0] === 'CLOSED') console.log('❌ CLOSED:', msg[1], msg[2]);
  if (msg[0] === 'EVENT') {
    const sub = msg[1];
    const ev = msg[2];
    const tags = ev.tags.map(t => `[${t.join(',')}]`).join(' ');
    console.log(`[${sub}] kind=${ev.kind} author=${ev.pubkey.slice(0,8)} tags: ${tags}`);
  }
  if (msg[0] === 'EOSE') console.log(`--- EOSE ${msg[1]} ---`);
});

ws.on('error', (e) => console.log('WS Error:', e.message));

setTimeout(() => { ws.close(); process.exit(0); }, 6000);
