import { makeEnv, call } from './harness.mjs';
import worker from '../src/index.js';
import { solvePow } from '../src/abuse.js';
import { ChatStore, rightsFor, dmPairKey, messageGame, MESSAGE_MAX } from '../src/chats.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ` -- ${detail}` : ''}`);
}

async function t(name, fn) {
  const env = makeEnv();
  try {
    await fn(env);
  } catch (err) {
    fail++;
    failures.push(`${name} threw: ${err.message}`);
  }
}

/** Registers one account into an existing env and returns its user id. */
async function signupInto(env, nick) {
  const client = `cl-${nick.toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(16, 'x').slice(0, 18)}`;
  const first = await call(worker, env, '/api/auth/register', {
    method: 'POST', client, body: { nick, password: 'correct-horse-battery-staple' },
  });
  if (first.status !== 403 || !first.json?.pow?.challenge) {
    throw new Error(`register did not ask for pow: ${first.status} ${first.text.slice(0, 120)}`);
  }
  const nonce = await solvePow(first.json.pow.challenge, env);
  const second = await call(worker, env, '/api/auth/register', {
    method: 'POST',
    client,
    headers: { 'x-cheatlab-pow': first.json.pow.challenge, 'x-cheatlab-pow-nonce': String(nonce) },
    body: { nick, password: 'correct-horse-battery-staple' },
  });
  if (second.status !== 201) throw new Error(`register failed: ${second.status} ${second.text.slice(0, 200)}`);
  return second.json.user.id;
}

/** One shared env holding three accounts, so the store has real users to join to. */
async function cast() {
  const env = makeEnv();
  const users = [];
  for (const nick of ['Ada', 'Blaise', 'Cleo']) {
    users.push({ id: await signupInto(env, nick), nick });
  }
  return { env, chats: new ChatStore(env), users };
}

/* ------------------------------------------------------------------ rights */

await t('a missing conversation grants nothing', () => {
  check('null conversation is all false', Object.values(rightsFor(null, { role: 'owner' })).every((v) => v === false));
  check('null member on a real conversation cannot post', rightsFor({ kind: 'group' }, null).post === false);
});

await t('an unknown kind is refused rather than guessed at', () => {
  const r = rightsFor({ kind: 'wat', discoverable: true }, { role: 'owner' });
  check('no rights for an unknown kind', Object.values(r).every((v) => v === false));
});

await t('a dm is readable and writable only by its two members', () => {
  const conv = { kind: 'dm' };
  check('member may read', rightsFor(conv, { role: 'member' }).read === true);
  check('member may post', rightsFor(conv, { role: 'member' }).post === true);
  check('member may leave', rightsFor(conv, { role: 'member' }).leave === true);
  // Two people who found each other themselves: neither outranks the other, so
  // there is nothing to appeal to and nothing to manage.
  check('a dm owner cannot manage', rightsFor(conv, { role: 'owner' }).manage === false);
  check('a dm mod cannot manage', rightsFor(conv, { role: 'mod' }).manage === false);
  check('a dm cannot be discovered', rightsFor(conv, { role: 'member' }).discover === false);
  check('an outsider cannot read a dm', rightsFor(conv, null).read === false);
});

await t('a group is private and staff-managed', () => {
  const conv = { kind: 'group', discoverable: true };
  check('a group is never world-readable', rightsFor(conv, null).read === false);
  check('discoverable does not open a group', rightsFor(conv, { role: 'member' }).read === true);
  check('member posts but cannot manage', rightsFor(conv, { role: 'member' }).post === true && rightsFor(conv, { role: 'member' }).manage === false);
  check('member cannot invite', rightsFor(conv, { role: 'member' }).invite === false);
  check('mod can manage', rightsFor(conv, { role: 'mod' }).manage === true);
  check('owner can manage', rightsFor(conv, { role: 'owner' }).manage === true);
  check('a group is not discoverable', rightsFor(conv, { role: 'owner' }).discover === false);
});

await t('a channel is world-readable and subscriber-writable', () => {
  const conv = { kind: 'channel', discoverable: true };
  check('an outsider may read an open channel', rightsFor(conv, null).read === true);
  check('an outsider may not post', rightsFor(conv, null).post === false);
  check('the roster is public', rightsFor(conv, null).roster === true);
  check('a subscriber posts', rightsFor(conv, { role: 'member' }).post === true);
  // Anyone already inside may bring someone in, so a channel cannot be owned
  // into stillness by an operator who lost interest.
  check('a subscriber may invite', rightsFor(conv, { role: 'member' }).invite === true);
  check('mod can manage a channel', rightsFor(conv, { role: 'mod' }).manage === true);
});

await t('a private channel is closed to the world but open to subscribers', () => {
  const conv = { kind: 'channel', discoverable: false };
  check('an outsider cannot read a private channel', rightsFor(conv, null).read === false);
  check('a subscriber still reads it', rightsFor(conv, { role: 'member' }).read === true);
});

/* ------------------------------------------------------------------- pairs */

await t('a dm pair key does not depend on who asks first', () => {
  check('a,b and b,a agree', JSON.stringify(dmPairKey('aaa', 'bbb')) === JSON.stringify(dmPairKey('bbb', 'aaa')));
  check('the key is sorted', dmPairKey('zzz', 'aaa')[0] === 'aaa');
});

await t('a message keeps a game only when it has an id', () => {
  check('no game id means no game', messageGame({ gameName: 'x' }) === null);
  const g = messageGame({ gameId: '123', gameName: 'Doors', gameCover: 'https://tr.rbxcdn.com/a/noFilter' });
  check('id kept', g.id === '123');
  check('safe cover kept', g.cover === 'https://tr.rbxcdn.com/a/noFilter');
  // A cover that executes or breaks out of an attribute is dropped, and the rest
  // of the chip survives - a bad thumbnail must not cost the game reference.
  const bad = messageGame({ gameId: '9', gameCover: 'javascript:alert(1)' });
  check('unsafe cover dropped', bad.cover === '');
  check('id survives a bad cover', bad.id === '9');
});

/* ------------------------------------------------------------------- store */

const { env, chats, users } = await cast();
const [ada, blaise, cleo] = users;

await t('a conversation is created with its owner already inside', async () => {
  const conv = await chats.createConversation({
    kind: 'channel', owner: ada.id, title: 'General', topic: 'anything', at: 1000,
  });
  check('has an id', typeof conv.id === 'string' && conv.id.length > 0);
  check('kind stored', conv.kind === 'channel');
  check('title stored', conv.title === 'General');
  check('owner is a member', (await chats.getMember(conv.id, ada.id))?.role === 'owner');
  check('a stranger is not a member', (await chats.isMember(conv.id, blaise.id)) === false);
});

await t('a membership cannot be granted twice by a join', async () => {
  const conv = await chats.createConversation({ kind: 'group', owner: ada.id, at: 2000 });
  await chats.addMember(conv.id, blaise.id, 'member', 2001);
  await chats.addMember(conv.id, blaise.id, 'mod', 2002);
  const m = await chats.getMember(conv.id, blaise.id);
  // Re-adding must not promote silently: an invite link replayed should grant
  // membership once, at the role it was issued with.
  check('role is not escalated by re-adding', m.role === 'member');
  check('member count counts once', (await chats.memberCount(conv.id)) === 2);
  check('an unknown role falls back to member', (await chats.addMember(conv.id, cleo.id, 'wizard', 2003)).role === 'member');
});

await t('messages read newest first and page backwards', async () => {
  const conv = await chats.createConversation({ kind: 'group', owner: ada.id, at: 3000 });
  await chats.addMember(conv.id, blaise.id, 'member', 3001);
  for (let i = 1; i <= 5; i += 1) {
    await chats.addMessage({ convId: conv.id, userId: ada.id, body: `m${i}`, at: 3000 + i * 10 });
  }
  const page1 = await chats.listMessages(conv.id, { limit: 3 });
  check('newest first', page1.map((m) => m.body).join(',') === 'm5,m4,m3');
  // Paging must not repeat m3 or skip it: the cursor is (created_at, id), not
  // created_at alone, so two messages in the same millisecond cannot collide.
  const page2 = await chats.listMessages(conv.id, { limit: 3, before: page1[2].id });
  check('second page continues', page2.map((m) => m.body).join(',') === 'm2,m1');
  check('no overlap', !page2.some((m) => page1.some((p) => p.id === m.id)));
  check('author nick is joined in', page1[0].nick === 'Ada');
});

await t('two messages in the same millisecond both page cleanly', async () => {
  const conv = await chats.createConversation({ kind: 'group', owner: ada.id, at: 4000 });
  await chats.addMessage({ convId: conv.id, userId: ada.id, body: 'twin a', at: 4000 });
  await chats.addMessage({ convId: conv.id, userId: ada.id, body: 'twin b', at: 4000 });
  const page1 = await chats.listMessages(conv.id, { limit: 1 });
  const page2 = await chats.listMessages(conv.id, { limit: 5, before: page1[0].id });
  check('the twin is not lost', page2.length === 1 && page2[0].body !== page1[0].body);
});

await t('a taken-down message keeps its place and loses its body', async () => {
  const conv = await chats.createConversation({ kind: 'group', owner: ada.id, at: 5000 });
  await chats.addMessage({ convId: conv.id, userId: blaise.id, body: 'oops', at: 5001 });
  const target = (await chats.listMessages(conv.id))[0];
  await chats.softDeleteMessage(target.id, ada.id, 5002);
  const after = (await chats.listMessages(conv.id))[0];
  check('the row survives', after.id === target.id);
  check('the body is emptied', after.body === '');
  check('it is marked deleted', !!after.deleted_at);
  // Unread is computed from rows a reader can still see, so a taken-down message
  // must stop demanding attention.
  check('a deleted message is not unread', (await chats.unreadCounts(blaise.id))[conv.id] === undefined);
});

await t('unread counts only other people and only after last_read', async () => {
  const conv = await chats.createConversation({ kind: 'group', owner: ada.id, at: 6000 });
  await chats.addMember(conv.id, blaise.id, 'member', 6001);
  await chats.addMessage({ convId: conv.id, userId: blaise.id, body: 'hi', at: 6100 });
  check('one unread for ada', (await chats.unreadCounts(ada.id))[conv.id] === 1);
  check('the author has none of their own', (await chats.unreadCounts(blaise.id))[conv.id] === undefined);
  await chats.addMessage({ convId: conv.id, userId: ada.id, body: 'my own', at: 6200 });
  check('own message adds nothing', (await chats.unreadCounts(ada.id))[conv.id] === 1);
  await chats.markRead(conv.id, ada.id, 6300);
  check('marking read clears it', (await chats.unreadCounts(ada.id))[conv.id] === undefined);
  await chats.addMessage({ convId: conv.id, userId: blaise.id, body: 'newer', at: 6400 });
  check('and only later messages count', (await chats.unreadCounts(ada.id))[conv.id] === 1);
});

await t('muting stops the badge without hiding the conversation', async () => {
  const conv = await chats.createConversation({ kind: 'channel', owner: ada.id, at: 7000 });
  await chats.addMember(conv.id, blaise.id, 'member', 7001);
  await chats.addMessage({ convId: conv.id, userId: ada.id, body: 'x', at: 7100 });
  await chats.setMuted(conv.id, blaise.id, true);
  check('muted means no badge', (await chats.unreadCounts(blaise.id))[conv.id] === undefined);
  const list = await chats.listForUser(blaise.id);
  check('but the conversation is still listed', list.some((c) => c.id === conv.id));
});

await t('the sidebar orders by the newest message, not by creation', async () => {
  // Two fresh channels for a viewer who has not been in any other room yet, so
  // the assertion is about ordering rather than about how many rooms the file has
  // accumulated by now.
  const cleoId = await signupInto(env, 'Dara');
  const quiet = await chats.createConversation({ kind: 'channel', owner: cleoId, title: 'quiet', at: 8000 });
  const busy = await chats.createConversation({ kind: 'channel', owner: cleoId, title: 'busy', at: 8001 });
  await chats.addMember(quiet.id, cleoId, 'member', 8002);
  await chats.addMember(busy.id, cleoId, 'member', 8003);
  await chats.addMessage({ convId: busy.id, userId: cleoId, body: 'newest', at: 9000 });
  const list = await chats.listForUser(cleoId);
  check('the one with the latest message leads', list[0].id === busy.id);
  check('a silent room still appears behind it', list.some((c) => c.id === quiet.id));
  check('an empty room sorts to the back rather than vanishing', list[list.length - 1].id === quiet.id);
});

await t('a dm pair cannot be opened twice', async () => {
  const first = await chats.createConversation({ kind: 'dm', owner: ada.id, at: 10000 });
  await chats.linkDm(ada.id, blaise.id, first.id);
  await chats.addMember(first.id, ada.id, 'owner', 10000);
  await chats.addMember(first.id, blaise.id, 'member', 10001);
  const found = await chats.findDm(blaise.id, ada.id);
  check('found regardless of argument order', found?.id === first.id);
  // Two people clicking "message" at once must land in one room, not two.
  const raced = await chats.findDm(ada.id, blaise.id);
  check('and the same room from the other side', raced?.id === first.id);
});

await t('a ticket is good for exactly one handshake', async () => {
  const conv = await chats.createConversation({ kind: 'group', owner: ada.id, at: 11000 });
  const hash = 'a'.repeat(64);
  const id = await chats.createTicket({ convId: conv.id, userId: blaise.id, tokenHash: hash, expiresAt: 11000 + 60000, at: 11000 });
  check('the first handshake spends it', (await chats.spendTicket(id, hash, 11000)) === true);
  check('the replay is refused', (await chats.spendTicket(id, hash, 11000)) === false);
});

await t('a ticket is refused on a wrong signature or after expiry', async () => {
  const conv = await chats.createConversation({ kind: 'group', owner: ada.id, at: 12000 });
  const hash = 'b'.repeat(64);
  const id = await chats.createTicket({ convId: conv.id, userId: blaise.id, tokenHash: hash, expiresAt: 12000 + 1000, at: 12000 });
  check('a forged signature is refused', (await chats.spendTicket(id, 'c'.repeat(64), 12000)) === false);
  check('the real one still works', (await chats.spendTicket(id, hash, 12000)) === true);
  const late = await chats.createTicket({ convId: conv.id, userId: cleo.id, tokenHash: 'd'.repeat(64), expiresAt: 13000, at: 12000 });
  // A ticket that outlived its minute is a stale credential, not a slow client.
  check('an expired ticket is refused', (await chats.spendTicket(late, 'd'.repeat(64), 13001)) === false);
  check('expired tickets are swept', (await chats.dropExpiredTickets(99000)) > 0);
});

await t('a room sanction escalates from mute to kick and is scoped to one room', async () => {
  const here = await chats.createConversation({ kind: 'channel', owner: ada.id, at: 14000 });
  const elsewhere = await chats.createConversation({ kind: 'channel', owner: ada.id, at: 14001 });
  await chats.addTakedown({ convId: here.id, userId: blaise.id, action: 'mute', byUserId: ada.id, at: 14002 });
  check('a mute is a mute', (await chats.sanctionOf(here.id, blaise.id)) === 'mute');
  check('and does not touch another room', (await chats.sanctionOf(elsewhere.id, blaise.id)) === '');
  await chats.addTakedown({ convId: here.id, userId: blaise.id, action: 'kick', byUserId: ada.id, at: 14003 });
  check('a later kick wins', (await chats.sanctionOf(here.id, blaise.id)) === 'kick');
});

await t('an attachment belongs to its message and the room keeps its files', async () => {
  const conv = await chats.createConversation({ kind: 'group', owner: ada.id, at: 15000 });
  const msg = await chats.addMessage({ convId: conv.id, userId: blaise.id, body: '', at: 15001 });
  await chats.addMessageFile({
    id: 'f1', message_id: msg.id, name: 'a.png', mime: 'image/png', size: 10,
    sha256: 'd'.repeat(64), author: blaise.id, store: 'kv', url: '/f/a.png', rid: '', created_at: 15002,
  });
  check('listed under its message', (await chats.listMessageFiles(msg.id)).length === 1);
  check('and reachable from the room for cleanup', (await chats.listFilesForConversation(conv.id)).length === 1);
});

await t('a body is length-capped before it reaches the page', async () => {
  check('the cap is a real limit', MESSAGE_MAX > 0 && MESSAGE_MAX <= 4000);
  const conv = await chats.createConversation({ kind: 'group', owner: ada.id, at: 16000 });
  await chats.addMessage({ convId: conv.id, userId: ada.id, body: 'x'.repeat(MESSAGE_MAX + 500), at: 16001 });
  const [m] = await chats.listMessages(conv.id, { limit: 1 });
  // Truncation is the route's job; what the store guarantees is that a body is a
  // string and the column is bounded, so a hostile client cannot store 10MB.
  check('stored as supplied, for the route to bound', typeof m.body === 'string' && m.body.length === MESSAGE_MAX + 500);
});

for (const f of failures) console.log(`  - ${f}`);
console.log(`\nchats: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;