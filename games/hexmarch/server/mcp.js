// MCP endpoint: the HTTP API's actions offered as tools, for agent harnesses
// that load tools over the Model Context Protocol. It speaks Streamable HTTP
// in its simplest form (stateless, one JSON reply per POST), which needs no
// dependency and no session bookkeeping. Tested against the official client.

import { sendJson } from './api.js';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'hexmarch', version: '0.3.0' };
const MAX_BODY = 64 * 1024;

const INSTRUCTIONS = 'Hexmarch is a simultaneous-turn conquest game. Call hexmarch_get_guide once for the rules. '
  + 'Then create or join a room, keep the code and token you are given, and loop: hexmarch_get_state with wait to block until it is your move, '
  + 'read the briefing, and reply with hexmarch_submit_move.';

const seat = {
  code: { type: 'string', description: 'The four-letter room code.' },
  token: { type: 'string', description: 'Your seat token, returned when you created or joined the room.' },
};
const rules = { type: 'object', description: 'Optional rule overrides, for example {"castleDefence":1}. See the guide for the list.' };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS = [
  { name: 'hexmarch_get_guide', action: 'get_guide',
    description: 'The rules of Hexmarch and how to play it through these tools. Read this first.',
    inputSchema: schema({}) },
  { name: 'hexmarch_create_room', action: 'create_room',
    description: 'Create a new room and take the first seat as host. Returns the room code and your token.',
    inputSchema: schema({
      name: { type: 'string', description: 'Your display name.' },
      phaseSeconds: { type: 'number', description: 'Seconds everyone has to seal each phase (default 180, 0 for no limit).' },
      rules,
    }, ['name']) },
  { name: 'hexmarch_join_room', action: 'join_room',
    description: 'Join a room someone else created, before the game starts. Returns your token.',
    inputSchema: schema({ code: seat.code, name: { type: 'string', description: 'Your display name.' } }, ['code', 'name']) },
  { name: 'hexmarch_add_bot', action: 'add_bot',
    description: 'Host only, before the game starts: add a built-in computer player.',
    inputSchema: schema({ ...seat, strategy: { type: 'string', enum: ['balanced', 'aggressive', 'fortress', 'passive', 'tuned'] } }, ['code', 'token']) },
  { name: 'hexmarch_start_game', action: 'start_game',
    description: 'Host only: start the game once at least two players are seated.',
    inputSchema: schema(seat, ['code', 'token']) },
  { name: 'hexmarch_get_state', action: 'get_state',
    description: 'See the game from your seat. With wait, blocks until it is your move or the game ends (or the wait runs out), so call it in a loop instead of polling. Returns a briefing written to decide from.',
    inputSchema: schema({
      ...seat,
      wait: { type: 'number', description: 'Seconds to wait for your move, up to 55. Default 0 returns at once.' },
      view: { type: 'string', enum: ['brief', 'json', 'full'], description: 'brief (default): text briefing. json: the full structured view. full: both.' },
    }, ['code', 'token']) },
  { name: 'hexmarch_submit_move', action: 'submit_move',
    description: 'Seal your move for the current phase: placements in the place phase, orders in the orders phase. An empty orders list holds position. You can call it again to replace your move until the last player seals.',
    inputSchema: schema({
      ...seat,
      placements: {
        type: 'array', description: 'Place phase: where your new armies go. Must add up to your income.',
        items: schema({ territory: { type: 'integer' }, armies: { type: 'integer', minimum: 1 } }, ['territory', 'armies']),
      },
      orders: {
        type: 'array', description: 'Orders phase: armies sent from one of your territories to a neighbour (an attack, or a move to your own land).',
        items: schema({ from: { type: 'integer' }, to: { type: 'integer' }, armies: { type: 'integer', minimum: 1 } }, ['from', 'to', 'armies']),
      },
    }, ['code', 'token']) },
  { name: 'hexmarch_get_odds', action: 'get_odds',
    description: 'Exact chance of winning a fight to the death, with expected survivors. Give code and token to use your game\'s rules.',
    inputSchema: schema({
      attackers: { type: 'integer', minimum: 0 },
      defenders: { type: 'integer', minimum: 0 },
      castle: { type: 'boolean', description: 'The target is a castle defended by its own player.' },
      clash: { type: 'boolean', description: 'Two attacking forces meeting on a border, rather than an attack on a garrison.' },
      ...seat,
    }, ['attackers', 'defenders']) },
  { name: 'hexmarch_leave_room', action: 'leave_room',
    description: 'Give up your seat. In a running game a bot takes it over.',
    inputSchema: schema(seat, ['code', 'token']) },
];

// Tool output is read by a model, so the briefing goes in as plain text
// rather than as an escaped string inside JSON.
function toText(result) {
  const { briefing, guide, ok, ...rest } = result;
  if (guide) return guide;
  const head = JSON.stringify(rest);
  return briefing ? `${head}\n\n${briefing}` : head;
}

async function answer(act, msg) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(-32600, 'Invalid request.');
  if (msg.id === undefined) return null; // a notification: nothing to send back

  switch (msg.method) {
    case 'initialize': {
      const wanted = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(wanted) ? wanted : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return error(-32602, `Unknown tool: ${msg.params?.name}`);
      try {
        const result = await act[tool.action](msg.params.arguments ?? {});
        return reply(result.ok
          ? { content: [{ type: 'text', text: toText(result) }] }
          : { content: [{ type: 'text', text: result.error }], isError: true });
      } catch (err) {
        console.error(err);
        return reply({ content: [{ type: 'text', text: 'Something went wrong.' }], isError: true });
      }
    }
    default:
      return error(-32601, `Method not found: ${msg.method}`);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function handleMcp(act, req, res) {
  if (req.method !== 'POST') {
    // No server-initiated stream and no sessions to end.
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } });
    return;
  }
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map((msg) => answer(act, msg)))).filter(Boolean);
  if (!replies.length) { res.writeHead(202).end(); return; }
  sendJson(res, 200, batch ? replies : replies[0]);
}
