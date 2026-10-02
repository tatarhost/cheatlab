import { secretMatches } from './util.js';

/**
 * One room of live delivery. It holds sockets and nothing else.
 *
 * The rule that shapes this file: a message never lives here. The Worker writes
 * it to D1 first, then fetches `/publish` below to hand the finished row to
 * whoever is listening. That means the DO cannot be used to slip a message past
 * authentication, a ban check or a throttle - there is no path into it that does
 * not start with a message D1 already accepted. The cost of that choice is that a
 * room evicted while it is busy loses its subscribers and they reconnect; the
 * benefit is that the one component holding open sockets has no ability to author
 * content.
 *
 * Hibernation is on, and that shapes the file more than anything else. A room
 * with nobody in it must be allowed to be evicted from memory, which means no
 * timers: `setInterval` and alarms both keep an isolate awake and billable, so
 * neither is used. Liveness is the runtime's problem - it answers protocol ping
 * frames on its own, without waking the object - and a dropped socket is
 * recovered from on the client, which reconnects with a fresh ticket.
 */

/** The prefix on every frame this room sends, so a client can tell them apart. */
const FRAME = { hello: 'hello', msg: 'msg', stale: 'stale' };

/**
 * The name a room is addressed by. Deterministic, so the Worker and the
 * client's upgrade request agree without either having to be told the other id.
 */
export function roomNameFor(convId) {
  return `chat:${convId}`;
}

/** Every live socket this room holds. */
function live(state) {
  // `getWebSockets()` is the only list that matters: it is the runtime's own
  // record, and it drops a socket the moment it closes, so there is no dead
  // entry to filter out here.
  return state.getWebSockets() || [];
}

/** Sends one frame, skipping sockets that are already gone. */
function send(ws, type, payload) {
  try {
    ws.send(JSON.stringify({ t: type, ...payload }));
  } catch {
    // A closed socket throws on send. That is not an error worth propagating -
    // the close event removes it, and one dead reader must not cost the others
    // their message.
  }
}

export class ConversationRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/publish' && request.method === 'POST') {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response('bad json', { status: 400 });
      }
      const sockets = this.forRoom(url);
      for (const ws of sockets) send(ws, FRAME.msg, { m: payload });
      return json({ sent: sockets.length });
    }

    if (url.pathname === '/wake' && request.method === 'POST') {
      // Sent when a message was stored while this room had no subscribers, so a
      // reader can be told its view is stale instead of guessing. It costs one
      // request on a message that nobody is waiting for, so it is only worth it
      // when a client has said it is polling; see `index.js`.
      const sockets = this.forRoom(url);
      for (const ws of sockets) send(ws, FRAME.stale, {});
      return json({ sockets: sockets.length });
    }

    if (url.pathname.endsWith('/ws')) return this.upgrade(request, url);
    return new Response('not found', { status: 404 });
  }

  /**
   * The live sockets of the room the request is addressed to.
   *
   * Each socket carries its room in its attachment, so a publish addressed to one
   * room can never reach a reader of another - not even if the stub in front of
   * this object were ever pointed at the wrong id, which is exactly the kind of
   * mistake that is invisible in review and loud in a user's screen.
   */
  forRoom(url) {
    const addressed = url.searchParams.get('id') || '';
    return live(this.state).filter((ws) => {
      const at = ws.deserializeAttachment?.();
      if (!at?.convId || !addressed) return true;
      return at.convId === addressed;
    });
  }

  /**
   * Takes the WebSocket, after spending a ticket.
   *
   * Everything about who is allowed in was decided by the Worker before the
   * ticket was minted. This method answers a narrower question - is this ticket
   * real, unused, unexpired, and issued for *this* room - and it answers it
   * against D1, which is the only place the answer can be trusted.
   */
  async upgrade(request, url) {
    // The room is named by the path, because the path is what the Worker routed
    // on and therefore what chose this object. The `id` query parameter exists so a
    // client can build the address without knowing the path shape, and it is only
    // ever a claim: if it disagrees with the path, the request is asking this room
    // to act for a conversation it does not hold, and it is refused rather than
    // quietly corrected.
    const addressed = /\/api\/chats\/([A-Za-z0-9]{6,24})\/ws$/.exec(url.pathname);
    const claimed = url.searchParams.get('id') || '';
    if (addressed && claimed && claimed !== addressed[1]) return new Response('room mismatch', { status: 400 });
    const convId = addressed ? addressed[1] : claimed;
    const ticket = url.searchParams.get('ticket') || '';
    const ticketId = url.searchParams.get('t') || '';

    if (!/^[A-Za-z0-9]{6,24}$/.test(convId)) return new Response('bad conversation', { status: 400 });
    if (!/^[A-Za-z0-9_-]{20,120}$/.test(ticket)) return new Response('bad ticket', { status: 400 });

    const row = await this.env.DB.prepare('SELECT * FROM chat_ticket WHERE id = ?').bind(ticketId).first();
    if (!row) return new Response('no such ticket', { status: 403 });
    if (row.conv_id !== convId) return new Response('ticket is for another room', { status: 403 });
    // Compared through the constant-time helper, and awaited: a plain `!==`
    // against the Promise `secretHash` returns would compare "object Object" with
    // a hex string and refuse every honest ticket.
    if (!(await secretMatches(ticket, row.token_hash))) return new Response('bad ticket', { status: 403 });
    if (row.used_at) return new Response('ticket already used', { status: 403 });
    if (!(row.expires_at > Date.now())) return new Response('ticket expired', { status: 403 });

    // Single use. The UPDATE is the lock: only one of two simultaneous upgrades
    // can move this row, so a ticket cannot open a second socket.
    const spent = await this.env.DB.prepare(
      'UPDATE chat_ticket SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?',
    ).bind(Date.now(), ticketId, Date.now()).run();
    if (!((spent?.meta?.changes || 0) > 0)) return new Response('ticket already used', { status: 403 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server);
    // The attachment is what survives hibernation: a woken room knows which room
    // and which reader it is holding without having kept anything in memory.
    server.serializeAttachment({ convId, userId: row.user_id, at: Date.now() });

    send(server, FRAME.hello, { convId, at: Date.now() });

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Attached to every socket, including ones restored after an eviction.
   *
   * The protocol is one-way on purpose: the client sends nothing over the socket.
   * A message written here would bypass the Worker, which is the whole reason
   * messages travel by POST. Runtime ping frames do not reach this handler.
   */
  async webSocketMessage() {}

  async webSocketClose(ws, code, reason, wasClean) {
    // Harmless with `web_socket_auto_reply_to_close` on, and required without it:
    // the runtime only closes the peer side if something asks it to.
    try {
      ws.close(code || 1000, reason || 'closed');
    } catch { /* already closed */ }
  }

  async webSocketError() {}
}

function json(body) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

export default { ConversationRoom };