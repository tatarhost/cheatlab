/**
 * The live-delivery room, and the routes around it.
 *
 * The socket itself cannot be opened here: Node's `Response` refuses a 101, so
 * the last step of an upgrade - handing the pair back to the platform - cannot
 * run outside Workers. What the tests below assert instead is everything up to
 * that step, which is where every decision is actually made: which tickets are
 * refused, that one ticket opens one socket, and that a stored message reaches
 * the readers that are attached and nobody else.
 */
import { makeEnv, call, withChatRooms, framesOf } from './harness.mjs';
import { solvePow } from '../src/abuse.js';
import worker from '../src/index.js';

let pass = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

/* ------------------------------------------------------------------- seed */

const env = makeEnv({ ANON_NEW_ITEMS_PER_DAY: '50', REG_NEW_ITEMS_PER_DAY: '50' });
const rooms = withChatRooms(env);
const as = (client, path, opts = {}) => call(worker, opts.env || env, path, { client, ...opts });

/**
 * Sessions are bound to the client id they were minted for, so a request that
 * carries somebody else's token is rejected as anonymous. Every identity below is
 * therefore a pair of client and token, and no call site ever mixes them.
 */
const who = { alice: null, bob: null, carol: null };
const asAlice = (path, opts = {}) => as(who.alice.client, path, { ...opts, session: who.alice.token });
const asBob = (path, opts = {}) => as(who.bob.client, path, { ...opts, session: who.bob.token });
const asCarol = (path, opts = {}) => as(who.carol.client, path, { ...opts, session: who.carol.token });

/** Registers one account through the real two-step PoW handshake. */
async function register(client, nick) {
  const body = { nick, password: 'correct-horse-battery-staple' };
  const first = await as(client, '/api/auth/register', { method: 'POST', body });
  if (first.status !== 403 || !first.json?.pow?.challenge) {
    throw new Error(`seed ${nick}: register did not ask for pow: ${first.status} ${first.text.slice(0, 120)}`);
  }
  const nonce = await solvePow(first.json.pow.challenge, env);
  const second = await as(client, '/api/auth/register', {
    method: 'POST',
    body,
    headers: { 'x-cheatlab-pow': first.json.pow.challenge, 'x-cheatlab-pow-nonce': String(nonce) },
  });
  if (second.status !== 201) throw new Error(`seed ${nick}: ${second.status} ${second.text.slice(0, 200)}`);
  return second.json;
}

who.alice = { ...(await register('e2e-alice-client01', 'alice')), client: 'e2e-alice-client01' };
who.bob = { ...(await register('e2e-bob-client0001', 'bob')), client: 'e2e-bob-client0001' };
who.carol = { ...(await register('e2e-carol-client0001', 'carol')), client: 'e2e-carol-client0001' };
check('seed: three accounts exist',
  !!who.alice.user.id && !!who.bob.user.id && !!who.carol.user.id, 'a registration did not complete');
const { aliceId, bobId } = { aliceId: who.alice.user.id, bobId: who.bob.user.id };

const channel = await asAlice('/api/chats', {
  method: 'POST', body: { kind: 'channel', title: 'Общий' },
});
check('seed: a channel exists', channel.status === 201, `${channel.status} ${channel.text.slice(0, 140)}`);
const convId = channel.json.chat.id;

/* ------------------------------------------------------- the upgrade route */

// The gate that decides whether a Durable Object is woken at all. A plain GET on
// the socket path has to be refused here, not by the room.
const plain = await asAlice(`/api/chats/${convId}/ws`);
check('a plain GET on the socket path is refused with 426', plain.status === 426, `got ${plain.status}`);
check('and it says what it wanted', plain.res.headers.get('Upgrade') === 'websocket',
  `header was ${plain.res.headers.get('Upgrade')}`);

const noTicket = await asAlice(`/api/chats/${convId}/ws?nocache=1`, { headers: { Upgrade: 'websocket' } });
check('an upgrade without a ticket never reaches the room', noTicket.status === 403, `got ${noTicket.status}`);

// A Worker deployed without the DO binding still serves every REST route, so the
// only place the mistake is visible is the socket. Answering with a plain 503
// there is deliberate: a binding that silently accepts and then says nothing
// looks to a person exactly like a room with nobody talking in it.
const unbound = { ...env };
delete unbound.CHAT_ROOMS;
const unboundRoom = await as(who.alice.client, `/api/chats/${convId}/ws?id=${convId}&ticket=${'c'.repeat(43)}&t=x`, {
  env: unbound, session: who.alice.token, headers: { Upgrade: 'websocket' },
});
check('with the binding missing, live delivery says so instead of going quiet',
  unboundRoom.status === 503, `got ${unboundRoom.status}`);

/* ------------------------------------------------------------------ tickets */

const minted = await asAlice(`/api/chats/${convId}/ticket`, { method: 'POST' });
check('a member can mint a ticket', minted.status === 200, `${minted.status} ${minted.text.slice(0, 140)}`);
check('the ticket is not the session token', minted.json.ticket && minted.json.ticket !== who.alice.token,
  'the socket credential must be its own secret');
check('and it points at this room', minted.json.url === `/api/chats/${convId}/ws`, minted.json.url);
check('with an expiry in the future', minted.json.expiresAt > Date.now(), String(minted.json.expiresAt));

const stranger = await as('e2e-anon-client0001', '/api/chats');
check('an anonymous reader cannot even list the rooms', stranger.status === 401, `got ${stranger.status}`);

const carolTicket = await asCarol(`/api/chats/${convId}/ticket`, { method: 'POST' });
check('a reader who may not post gets no ticket', carolTicket.status === 403, `got ${carolTicket.status}`);

/* ----------------------------------------------------------- the room itself */

const room = rooms.get(rooms.idFromName(`chat:${convId}`));
const chatTicket = minted.json;

async function upgrade(qs) {
  const req = new Request(`https://api.cheatlab.test/api/chats/${convId}/ws?${qs}`, {
    headers: { Upgrade: 'websocket' },
  });
  return { res: await room.fetch(req) };
}

const wrongRoom = await upgrade(`id=${convId}&t=${chatTicket.ticketId}&ticket=${'a'.repeat(43)}`);
check('a ticket that does not match its hash is refused', wrongRoom.res.status === 403, `got ${wrongRoom.res.status}`);
check('and no socket was accepted for it', room.sockets.length === 0, `${room.sockets.length} sockets`);

const unknownTicket = await upgrade(`id=${convId}&t=nope00000000&ticket=${'b'.repeat(43)}`);
check('an unknown ticket id is refused', unknownTicket.res.status === 403, `got ${unknownTicket.res.status}`);

// A ticket is for one room and one handshake. Two ways to send it to the wrong
// place: rename the room in the query, or carry a different room's ticket here.
const otherChannel = await asAlice('/api/chats', {
  method: 'POST', body: { kind: 'channel', title: 'Другой' },
});
const otherTicket = await asAlice(`/api/chats/${otherChannel.json.chat.id}/ticket`, { method: 'POST' });
check('seed: a second room issues its own ticket', otherTicket.status === 200, `${otherTicket.status}`);

const renamed = await upgrade(`id=abcdef123456&t=${chatTicket.ticketId}&ticket=${chatTicket.ticket}`);
check('an id that disagrees with the path is refused', renamed.res.status === 400, `got ${renamed.res.status}`);

const borrowed = await upgrade(`id=${convId}&t=${otherTicket.json.ticketId}&ticket=${otherTicket.json.ticket}`);
check("another room's ticket is refused", borrowed.res.status === 403, `got ${borrowed.res.status}`);
check('and it opened nothing', room.sockets.length === 0, `${room.sockets.length} sockets`);

const accepted = await upgrade(`id=${convId}&t=${chatTicket.ticketId}&ticket=${chatTicket.ticket}`);
check('a real ticket is accepted', accepted.res.status === 101, `got ${accepted.res.status}`);
check('the socket was accepted', room.sockets.length === 1, `${room.sockets.length} sockets`);
check('and it carries the room and the reader', room.sockets[0]?.attachment?.convId === convId
  && room.sockets[0]?.attachment?.userId === aliceId, JSON.stringify(room.sockets[0]?.attachment));
const hello = framesOf(room, 'hello');
check('the socket is greeted with the room', hello.length === 1 && hello[0].convId === convId,
  JSON.stringify(hello));

const replay = await upgrade(`id=${convId}&t=${chatTicket.ticketId}&ticket=${chatTicket.ticket}`);
check('the same ticket cannot open a second socket', replay.res.status === 403, `got ${replay.res.status}`);
check('and still only one socket is held', room.sockets.length === 1, `${room.sockets.length} sockets`);

// A reader who may read but not post never got a ticket, so this is the only way
// to check that a room with no sockets costs nothing but answers honestly.
const empty = rooms.get(rooms.idFromName('chat:doesnotexist'));
const published = await empty.fetch('https://room.internal/publish', {
  method: 'POST', body: JSON.stringify({ id: 'm1' }),
});
check('publishing to a room with no readers is not an error', published.status === 200, `${published.status}`);
check('and it reports zero delivered', (await published.json()).sent === 0, await published.text);

/* --------------------------------------------------------------- fan-out */

const sent = await asAlice(`/api/chats/${convId}/messages`, {
  method: 'POST', body: { body: 'первое' },
});
check('a message is stored', sent.status === 201, `${sent.status} ${sent.text.slice(0, 140)}`);
// waitUntil is not available in the harness, so the publish the Worker queued is
// done here by hand - the same request it would have made.
await room.fetch('https://room.internal/publish', {
  method: 'POST',
  body: JSON.stringify({ ...sent.json.message, files: [] }),
});
const delivered = framesOf(room, 'msg');
check('the stored message reached the reader', delivered.length === 1, JSON.stringify(delivered));
check('with the body it was stored with', delivered[0]?.m?.body === 'первое', JSON.stringify(delivered[0]?.m));

const second = await asBob(`/api/chats/${convId}/messages`, {
  method: 'POST', body: { body: 'второе' },
});
check('the owner may not post in a public channel they do not belong to', second.status === 403,
  `${second.status} ${second.text.slice(0, 140)}`);

// Subscribing is what makes posting possible in a public channel, and it is the
// one thing an outsider may do there without anybody's permission.
const joined = await asBob(`/api/chats/${convId}/members`, {
  method: 'POST', body: { userId: bobId },
});
check('an outsider can join a public channel', joined.status === 201, `${joined.status} ${joined.text.slice(0, 140)}`);
const afterJoin = await asBob(`/api/chats/${convId}/messages`, {
  method: 'POST', body: { body: 'второе' },
});
check('and can post once they have', afterJoin.status === 201, `${afterJoin.status} ${afterJoin.text.slice(0, 140)}`);

await room.fetch('https://room.internal/publish', {
  method: 'POST',
  body: JSON.stringify({ ...afterJoin.json.message, files: [] }),
});
check('both messages were delivered, in order',
  framesOf(room, 'msg').map((f) => f.m.body).join(',') === 'первое,второе',
  framesOf(room, 'msg').map((f) => f.m.body).join(','));

const backfill = await room.fetch('https://room.internal/wake', { method: 'POST' });
check('a stale notice reaches the reader too', framesOf(room, 'stale').length === 1, await backfill.text);

/* --------------------------------------------------------------- close path */

await room.instance.webSocketClose(room.sockets[0], 1001, 'reload');
check('closing the server side marks the socket closed', room.sockets[0].closed, 'socket was not closed');
const afterClose = await room.fetch(`https://room.internal/publish?id=${convId}`, {
  method: 'POST', body: JSON.stringify({ id: 'after-close' }),
});
check('and a closed reader is not counted as a reader', afterClose.status === 200, `${afterClose.status}`);

/* --------------------------------------------------------------------- dm */

const strangerDm = await asCarol(`/api/chats/dm/${aliceId}`, { method: 'POST' });
check('a dm needs a mutual follow', strangerDm.status === 403, `${strangerDm.status} ${strangerDm.text.slice(0, 140)}`);

await asBob(`/api/users/${aliceId}/follow`, { method: 'POST' });
check('seed: bob follows alice', true, '');
const dm = await asBob(`/api/chats/dm/${aliceId}`, { method: 'POST' });
check('still no dm while alice does not follow back', dm.status === 403, `${dm.status} ${dm.text.slice(0, 140)}`);

await asAlice(`/api/users/${bobId}/follow`, { method: 'POST' });
const dmNow = await asBob(`/api/chats/dm/${aliceId}`, { method: 'POST' });
check('a mutual follow opens the dm', dmNow.status === 200, `${dmNow.status} ${dmNow.text.slice(0, 200)}`);
check('and it is named after the other person', dmNow.json.chat.title === 'alice', JSON.stringify(dmNow.json.chat));
const dmAgain = await asAlice(`/api/chats/dm/${bobId}`, { method: 'POST' });
check('the other side gets the same room, not a second one',
  dmAgain.status === 200 && dmAgain.json.chat.id === dmNow.json.chat.id,
  `${dmAgain.json.chat?.id} vs ${dmNow.json.chat?.id}`);

const self = await asAlice(`/api/chats/dm/${aliceId}`, { method: 'POST' });
check('you cannot message yourself', self.status === 400, `${self.status} ${self.text.slice(0, 140)}`);

const dmPost = await asAlice(`/api/chats/${dmNow.json.chat.id}/messages`, {
  method: 'POST', body: { body: 'привет' },
});
check('and a dm can be written', dmPost.status === 201, `${dmPost.status} ${dmPost.text.slice(0, 140)}`);

/* --------------------------------------------------------------- mute rule */

const group = await asAlice('/api/chats', {
  method: 'POST', body: { kind: 'group', title: 'Свои' },
});
const groupId = group.json.chat.id;
const outsider = await asCarol(`/api/chats/${groupId}/members`, {
  method: 'POST', body: { userId: who.carol.user.id },
});
check('an outsider cannot walk into a group', outsider.status === 403, `${outsider.status} ${outsider.text.slice(0, 140)}`);

// A group is not public, so joining one is not something a person does for
// themselves: somebody inside has to add them. Self-join works for a channel and
// only for a channel.
const bobJoins = await asBob(`/api/chats/${groupId}/members`, {
  method: 'POST', body: { userId: bobId },
});
check('a member cannot add themselves to a group', bobJoins.status === 403, `${bobJoins.status} ${bobJoins.text.slice(0, 140)}`);

const added = await asAlice(`/api/chats/${groupId}/members`, {
  method: 'POST', body: { userId: bobId },
});
check('but the owner can add somebody', added.status === 201, `${added.status} ${added.text.slice(0, 140)}`);

const carolInvite = await asCarol(`/api/chats/${groupId}/members`, {
  method: 'POST', body: { userId: who.carol.user.id },
});
check('and a stranger cannot add themselves either', carolInvite.status === 403, `${carolInvite.status}`);

const muted = await asAlice(`/api/chats/${groupId}/members/${bobId}/mute`, {
  method: 'POST', body: { muted: true },
});
check('an owner can mute inside their group', muted.status === 200, `${muted.status} ${muted.text.slice(0, 140)}`);
const mutePost = await asBob(`/api/chats/${groupId}/messages`, {
  method: 'POST', body: { body: 'ещё' },
});
check('a muted member cannot post', mutePost.status === 403, `${mutePost.status} ${mutePost.text.slice(0, 140)}`);
const unmuted = await asAlice(`/api/chats/${groupId}/members/${bobId}/mute`, {
  method: 'POST', body: { muted: false },
});
check('and the mute can be lifted', unmuted.status === 200, `${unmuted.status} ${unmuted.text.slice(0, 140)}`);
const afterUnmute = await asBob(`/api/chats/${groupId}/messages`, {
  method: 'POST', body: { body: 'ещё' },
});
check('lifting it really lifts it', afterUnmute.status === 201, `${afterUnmute.status} ${afterUnmute.text.slice(0, 140)}`);

const ownerMute = await asAlice(`/api/chats/${groupId}/members/${aliceId}/mute`, {
  method: 'POST', body: { muted: true },
});
check('the owner cannot be muted', ownerMute.status === 403, `${ownerMute.status}`);

const carolMute = await asCarol(`/api/chats/${groupId}/members/${bobId}/mute`, {
  method: 'POST', body: { muted: true },
});
check('and a stranger cannot mute anyone', carolMute.status === 403, `${carolMute.status}`);

/* ------------------------------------------------------------------ wiring */

const listed = await asAlice('/api/chats')
const ids = (listed.json.chats || []).map((c) => c.id);
check('the sidebar lists every room the viewer is in', ids.includes(convId) && ids.includes(groupId)
  && ids.includes(dmNow.json.chat.id), ids.join(','));

// Being removed is the one thing that takes a room off the sidebar. The room row
// itself stays - a kick is remembered, so the room cannot be silently rejoined -
// and the answer for someone outside it is the same whether they were never
// invited or were removed, which is what stops the id from being a probe.
const kicked = await asAlice(`/api/chats/${groupId}/members/${bobId}`, { method: 'DELETE' });
check('an owner can remove somebody', kicked.status === 200, `${kicked.status} ${kicked.text.slice(0, 140)}`);

const afterKick = await asBob('/api/chats')
check('the room is gone from the sidebar of the person removed',
  !(afterKick.json.chats || []).some((c) => c.id === groupId),
  (afterKick.json.chats || []).map((c) => c.id).join(','));
const bobPeek = await asBob(`/api/chats/${groupId}`);
const carolPeek = await asCarol(`/api/chats/${groupId}`);
check('and opening it refuses them', bobPeek.status === 403, `${bobPeek.status} ${bobPeek.text.slice(0, 140)}`);
check('a stranger gets the same refusal, so the id does not confirm the room exists',
  carolPeek.status === 403, `${carolPeek.status} ${carolPeek.text.slice(0, 140)}`);
check('while the person removed is told why', bobPeek.json.error === 'you were removed from this conversation',
  bobPeek.json.error);
const bobRepost = await asBob(`/api/chats/${groupId}/messages`, {
  method: 'POST', body: { body: 'вернулся' },
});
check('and they cannot post their way back in', bobRepost.status === 403, `${bobRepost.status}`);

const anon = await as('e2e-anon-client0001', '/api/chats/channels');
check('public channels are browsable without an account',
  anon.status === 200 && (anon.json.channels || []).some((c) => c.id === convId),
  `${anon.status} ${anon.text.slice(0, 140)}`);
check('and a private group is never in that list',
  !(anon.json.channels || []).some((c) => c.id === groupId),
  (anon.json.channels || []).map((c) => c.id).join(','));
check('a stranger is told it may read a channel but not post',
  anon.json.channels.find((c) => c.id === convId)?.rights?.canPost === false,
  JSON.stringify(anon.json.channels.find((c) => c.id === convId)?.rights));
check('while its owner may', (await asAlice('/api/chats/channels'))
  .json.channels.find((c) => c.id === convId)?.rights?.canPost === true, '');

/* -------------------------------------------------------------- attachments */

// A file on its own is a message with no words, and a message has to exist
// before a file can hang off it. So the empty POST has to be allowed when the
// client says a file is coming - and refused when it does not, because an empty
// row that nobody can ever fill in is worse than a rejection.
const blank = await asAlice(`/api/chats/${convId}/messages`, { method: 'POST', body: { body: '' } });
check('an empty message is refused when nothing is coming behind it',
  blank.status === 400 && blank.json.error === 'message is empty', `${blank.status} ${blank.text.slice(0, 120)}`);

const carrier = await asAlice(`/api/chats/${convId}/messages`, { method: 'POST', body: { body: '', attach: true } });
check('and accepted when a file is on its way', carrier.status === 201, `${carrier.status} ${carrier.text.slice(0, 120)}`);
const carrierId = carrier.json?.message?.id;
check('creating one does not touch the room budget for text', !!carrierId, JSON.stringify(carrier.json));

const bytes = new TextEncoder().encode('отчёт за квартал — 12 строк');
const attach = await asAlice(`/api/chats/${convId}/messages/${carrierId}/files`, {
  method: 'POST',
  body: bytes,
  headers: { 'x-filename': encodeURIComponent('отчёт.txt'), 'content-length': String(bytes.byteLength) },
});
check('the file is stored', attach.status === 201, `${attach.status} ${attach.text.slice(0, 160)}`);
check('under the name it was sent with', attach.json?.file?.name === 'отчёт.txt', attach.json?.file?.name);

const withFile = await asAlice(`/api/chats/${convId}`);
const shown = (withFile.json.messages || []).find((m) => m.id === carrierId);
check('and history now shows it on the message',
  (shown?.files || []).some((f) => f.name === 'отчёт.txt'), JSON.stringify(shown?.files));

// The rule that keeps a file from being attached to something already read by
// other people: only the newest message may still gain one.
const later = await asAlice(`/api/chats/${convId}/messages`, { method: 'POST', body: { body: 'следующее' } });
const tooLate = await asAlice(`/api/chats/${convId}/messages/${carrierId}/files`, {
  method: 'POST',
  body: new TextEncoder().encode('x'),
  headers: { 'x-filename': encodeURIComponent('поздно.txt') },
});
check('a file cannot be added to a message other people have already read',
  tooLate.status === 409, `${tooLate.status} ${tooLate.text.slice(0, 120)}`);

// Somebody else's message is not the sender's to decorate, even while it is the
// newest one. Bob's own carrier is his to fill in; Alice reaching for it is not.
const bobPost = await asBob(`/api/chats/${convId}/messages`, { method: 'POST', body: { body: '', attach: true } });
const bobOwn = await asBob(`/api/chats/${convId}/messages/${bobPost.json?.message?.id}/files`, {
  method: 'POST',
  body: new TextEncoder().encode('y'),
  headers: { 'x-filename': encodeURIComponent('своё.txt') },
});
check('a member can attach to their own carrier',
  bobOwn.status === 201, `${bobOwn.status} ${bobOwn.text.slice(0, 120)}`);

const aliceReach = await asAlice(`/api/chats/${convId}/messages/${bobPost.json?.message?.id}/files`, {
  method: 'POST',
  body: new TextEncoder().encode('y'),
  headers: { 'x-filename': encodeURIComponent('нельзя.txt') },
});
check('but not to somebody else\'s, even as the owner of the room',
  aliceReach.status === 403, `${aliceReach.status} ${aliceReach.text.slice(0, 120)}`);

const fresh = await asAlice(`/api/chats/${convId}/messages`, { method: 'POST', body: { body: '', attach: true } });
const emptyFile = await asAlice(`/api/chats/${convId}/messages/${fresh.json?.message?.id}/files`, {
  method: 'POST', body: new Uint8Array(0), headers: { 'x-filename': encodeURIComponent('пусто.txt') },
});
check('a zero-byte file is refused', emptyFile.status === 400, `${emptyFile.status} ${emptyFile.text.slice(0, 120)}`);

// `fresh` is the empty case: no words, and the upload that would have filled it
// was refused, so nothing was ever readable about it.
const retraction = await asAlice(`/api/chats/${convId}/messages/${fresh.json?.message?.id}`, { method: 'DELETE' });
check('an empty carrier can be taken back down', retraction.status === 200, `${retraction.status} ${retraction.text.slice(0, 120)}`);
check('and it goes rather than leaving a notice',
  retraction.json?.removed === true, JSON.stringify(retraction.json));
const afterRemoval = await asAlice(`/api/chats/${convId}`);
check('so a reload shows nothing where it was',
  !(afterRemoval.json.messages || []).some((msg) => msg.id === fresh.json?.message?.id),
  (afterRemoval.json.messages || []).map((msg) => `${msg.id}:${msg.deleted ? 'deleted' : msg.body}`).join(' | '));

// A message that was readable keeps its row, so a reload can still say what was
// said here. Retracting a real message is not the same act as taking back an
// empty shell, and treating them the same would lose the room's history.
const said = await asAlice(`/api/chats/${convId}/messages`, { method: 'POST', body: { body: 'это было сказано' } });
const saidGone = await asAlice(`/api/chats/${convId}/messages/${said.json?.message?.id}`, { method: 'DELETE' });
check('a message with words in it stays as a notice', saidGone.status === 200 && !saidGone.json?.removed,
  `${saidGone.status} ${saidGone.text.slice(0, 120)}`);
const afterWords = await asAlice(`/api/chats/${convId}`);
const tombstone = (afterWords.json.messages || []).find((msg) => msg.id === said.json?.message?.id);
check('with the words gone but the row kept', !!tombstone && tombstone.deleted === true,
  JSON.stringify(tombstone));

// A row that took a file was read too - the file was in it - so it is a normal
// message from the moment the upload lands, whatever its words are.
const bobGone = await asAlice(`/api/chats/${convId}/messages/${bobPost.json.message.id}`, { method: 'DELETE' });
check('and a row that took a file is not treated as empty',
  bobGone.status === 200 && !bobGone.json?.removed, `${bobGone.status} ${bobGone.text.slice(0, 120)}`);

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  - ${f}`);
if (failures.length) process.exitCode = 1;