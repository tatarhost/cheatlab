import { str, newId } from './util.js';
import { isSafeImageUrl } from './urls.js';

/**
 * Chats: channels, groups and direct messages between friends.
 *
 * Bodies are stored in D1 and only *fanned out* by the Durable Object. That split
 * is the important decision in this file and it is deliberate. The Worker already
 * knows how to authenticate a person, refuse a banned account, throttle a flood,
 * sanitise a field and hand bytes to Cloudinary. If the DO accepted message
 * bodies, all of that would have to be written a second time inside the DO, and
 * the second copy would be the one without the ban check. Instead a message
 * travels the same path as everything else - HTTPS to the Worker - and the DO is
 * only told "here is a message that already exists, show it to whoever is
 * listening". A socket that is down costs delivery, never the message.
 *
 * Three kinds, differing only in who may read and who may post:
 *
 *   dm      exactly two people, and only mutual followers may open one. Without
 *           that gate this site - which publishes anonymously and by link - would
 *           be a way to message anyone who ever posted here.
 *   channel world-readable, subscriber-writable. One author, many readers.
 *   group   private and invitation-only, every member writes.
 */

/** The three conversation kinds. Anything else is refused by `rightsFor`. */
export const KINDS = ['dm', 'channel', 'group'];

/** Roles, most privileged first. `owner` is assigned once and never reassigned. */
const ROLES = ['owner', 'mod', 'member'];

export const MESSAGE_MAX = 2000;
export const TITLE_MAX = 80;
export const TOPIC_MAX = 200;

/** A ticket is only good long enough to cross one TLS handshake. */
export const TICKET_TTL_MS = 60 * 1000;

/**
 * What this member may do here. Pure, so the rules are testable without a
 * database and so that every route answers the question the same way.
 *
 * The shape is deliberately flat and boolean: a route that needs a new capability
 * gets `undefined` rather than a silently wrong `true`, so forgetting to extend
 * this is visible in review instead of in production.
 *
 * `conv` may be null (the conversation does not exist) and `member` may be null
 * (the viewer is not in it). Both produce "no rights" rather than throwing,
 * because those are the two cases an unauthorised request actually arrives as.
 */
export function rightsFor(conv, member) {
  if (!conv) return NO_RIGHTS;
  const inRoom = !!member;
  const staff = member?.role === 'owner' || member?.role === 'mod';

  switch (conv.kind) {
    case 'dm':
      // Two people who found each other themselves. Neither can rename the
      // conversation or evict the other - there is no authority to appeal to,
      // so the only move available is leaving.
      return { read: inRoom, post: inRoom, manage: false, invite: inRoom, leave: inRoom, roster: inRoom, discover: false };

    case 'group':
      // Private: not even a valid member may post without having been invited.
      return { read: inRoom, post: inRoom, manage: staff, invite: staff, leave: inRoom, roster: inRoom, discover: false };

    case 'channel':
      // The broadcast shape. Reading is public, which is why `roster` and
      // `discover` are public too - a channel whose reader list is secret is
      // just a group with extra steps. Posting stays closed, so an open channel
      // cannot be used to reach every visitor's notifications.
      return {
        read: inRoom || !!conv.discoverable,
        post: inRoom,
        manage: staff,
        // Anyone already inside may bring someone in: a public channel that only
        // the owner can grow is a dead channel.
        invite: inRoom,
        leave: inRoom,
        roster: true,
        discover: true,
      };

    default:
      return NO_RIGHTS;
  }
}

const NO_RIGHTS = {
  read: false, post: false, manage: false, invite: false, leave: false, roster: false, discover: false,
};

/** True when the viewer is allowed to write here. */
export function canPost(conv, member) {
  return rightsFor(conv, member).post;
}

/**
 * The pair key for a direct conversation, so the same two people cannot open two
 * of them. Ordering the pair makes the key independent of who asks first.
 */
export function dmPairKey(a, b) {
  return a < b ? [a, b] : [b, a];
}

/** Game fields on a message, judged by the same url rule as a post's cover. */
export function messageGame(payload) {
  const id = str(payload.gameId, 40);
  if (!id) return null;
  const cover = str(payload.gameCover, 600);
  return {
    id,
    name: str(payload.gameName, 120),
    cover: isSafeImageUrl(cover, 600) ? cover : '',
  };
}

/* ------------------------------------------------------------------- store */

const clampLimit = (n, max) => Math.min(max, Math.max(1, Number(n) || 1));

/**
 * Ids come from the shared alphabet rather than a UUID, so every id in the
 * database matches one route pattern and one id charset check. The prefix keeps
 * an id self-describing when it turns up in a log.
 */
const convId = () => newId(12);
const msgId = () => newId(16);
const fileId = () => newId(12);
const takedownId = () => newId(10);

export class ChatStore {
  constructor(env) {
    this.db = env.DB;
  }

  async rows(sql, ...params) {
    const res = await this.db.prepare(sql).bind(...params).all();
    return res?.results || [];
  }

  /* conversations */

  async createConversation({ kind, owner, title = '', topic = '', discoverable = true, at = Date.now() }) {
    const id = convId();
    await this.db
      .prepare(
        `INSERT INTO conversation (id, kind, title, topic, owner, discoverable, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(id, kind, title, topic, owner, discoverable ? 1 : 0, at, at)
      .run();
    // The owner joins in the same breath as the room. Without this the conversation
    // exists with nobody in it: invisible in `listForUser`, absent from the
    // membership join that decides who may read, and unopenable by the person who
    // just made it.
    await this.addMember(id, owner, 'owner', at);
    return this.getConversation(id);
  }

  async getConversation(id) {
    return (await this.db.prepare('SELECT * FROM conversation WHERE id = ?').bind(id).first()) || null;
  }

  /**
   * One room as a specific viewer sees it.
   *
   * A dm has no title of its own - it is a pairing of two accounts, not a named
   * room - so the name comes from the other person. Resolving it here means the
   * sidebar, the room view and the dm route all read the same row instead of each
   * inventing its own fallback.
   */
  async getConversationFor(id, viewerId) {
    const conv = await this.getConversation(id);
    if (!conv) return null;
    if (conv.kind !== 'dm') return conv;
    const peer = await this.db
      .prepare(`SELECT m.user_id, u.nick FROM conversation_member m JOIN user u ON u.id = m.user_id
                 WHERE m.conv_id = ? AND m.user_id <> ? LIMIT 1`)
      .bind(id, viewerId)
      .first();
    return { ...conv, peer_nick: peer?.nick || '', peer_id: peer?.user_id || null };
  }

  async updateConversation(id, { title, topic, discoverable }) {
    const cur = await this.getConversation(id);
    if (!cur) return null;
    await this.db
      .prepare('UPDATE conversation SET title = ?, topic = ?, discoverable = ?, updated_at = ? WHERE id = ?')
      .bind(
        title === undefined ? cur.title : title,
        topic === undefined ? cur.topic : topic,
        discoverable === undefined ? cur.discoverable : (discoverable ? 1 : 0),
        Date.now(),
        id,
      )
      .run();
    return this.getConversation(id);
  }

  async touchConversation(id) {
    await this.db.prepare('UPDATE conversation SET updated_at = ? WHERE id = ?').bind(Date.now(), id).run();
  }

  async deleteConversation(id) {
    // The message rows cascade, but Cloudinary assets do not - an attachment row
    // vanishing silently would leave the bytes paid for and unreachable. The
    // route destroys them first, this is the last step.
    await this.db.prepare('DELETE FROM conversation WHERE id = ?').bind(id).run();
  }

  /* direct conversations */

  /** The existing dm between two people, or null. The pair row is the only key. */
  async findDm(a, b) {
    const [lo, hi] = dmPairKey(a, b);
    const row = await this.db
      .prepare('SELECT conv_id FROM conversation_pair WHERE a = ? AND b = ?')
      .bind(lo, hi)
      .first();
    return row ? this.getConversation(row.conv_id) : null;
  }

  async linkDm(a, b, convId) {
    const [lo, hi] = dmPairKey(a, b);
    // Both directions are written, and both are looked up the same way, so the
    // pair table stays symmetric and a future query need not sort its arguments.
    for (const [x, y] of [[lo, hi], [hi, lo]]) {
      await this.db
        .prepare('INSERT OR REPLACE INTO conversation_pair (a, b, conv_id) VALUES (?,?,?)')
        .bind(x, y, convId)
        .run();
    }
  }

  /* members */

  async getMember(convId, userId) {
    return (await this.db
      .prepare('SELECT * FROM conversation_member WHERE conv_id = ? AND user_id = ?')
      .bind(convId, userId)
      .first()) || null;
  }

  async isMember(convId, userId) {
    return !!(await this.getMember(convId, userId));
  }

  async addMember(convId, userId, role = 'member', at = Date.now()) {
    if (!ROLES.includes(role)) role = 'member';
    await this.db
      .prepare(
        `INSERT INTO conversation_member (conv_id, user_id, role, joined_at, last_read_at, muted)
         VALUES (?,?,?,?,0,0)
         ON CONFLICT(conv_id, user_id) DO NOTHING`,
      )
      .bind(convId, userId, role, at)
      .run();
    return this.getMember(convId, userId);
  }

  async removeMember(convId, userId) {
    const res = await this.db
      .prepare('DELETE FROM conversation_member WHERE conv_id = ? AND user_id = ?')
      .bind(convId, userId)
      .run();
    return (res?.meta?.changes || 0) > 0;
  }

  async memberCount(convId) {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS n FROM conversation_member WHERE conv_id = ?')
      .bind(convId)
      .first();
    return row?.n || 0;
  }

  async listMembers(convId, { limit = 200 } = {}) {
    return this.rows(
      `SELECT m.user_id, m.role, m.joined_at, m.muted, u.nick, u.popular, u.avatar_id
         FROM conversation_member m JOIN user u ON u.id = m.user_id
        WHERE m.conv_id = ? ORDER BY m.joined_at ASC LIMIT ?`,
      convId, clampLimit(limit, 500),
    );
  }

  async setRole(convId, userId, role) {
    if (!ROLES.includes(role)) return null;
    await this.db
      .prepare('UPDATE conversation_member SET role = ? WHERE conv_id = ? AND user_id = ?')
      .bind(role, convId, userId)
      .run();
    return this.getMember(convId, userId);
  }

  async setMuted(convId, userId, muted) {
    await this.db
      .prepare('UPDATE conversation_member SET muted = ? WHERE conv_id = ? AND user_id = ?')
      .bind(muted ? 1 : 0, convId, userId)
      .run();
  }

  /** Marks everything up to `at` as seen. Unread is a number, not a receipt list. */
  async markRead(convId, userId, at = Date.now()) {
    await this.db
      .prepare('UPDATE conversation_member SET last_read_at = ? WHERE conv_id = ? AND user_id = ? AND last_read_at < ?')
      .bind(at, convId, userId, at)
      .run();
  }

  /**
   * The viewer's conversations with the number that decides their ordering and
   * the one that decides whether they are visited: unread and last message.
   *
   * Both come from a single grouped query rather than a count per conversation.
   * A sidebar of forty conversations would otherwise be forty round trips, which
   * on D1 is forty queries to make the page render.
   */
  async listForUser(userId, { limit = 60 } = {}) {
    const rows = await this.rows(
      `SELECT c.*, m.role, m.last_read_at, m.muted,
              (SELECT COUNT(*) FROM conversation_member z WHERE z.conv_id = c.id) AS members,
              COUNT(x.id) AS messages,
              MAX(x.created_at) AS last_at,
              -- A dm has no title of its own, so the sidebar names it after the
              -- other person. Resolved here rather than per row in the Worker,
              -- because N+1 for the one list every signed-in page opens is the
              -- kind of cost that only shows up in production.
              (SELECT u.nick FROM conversation_member o JOIN user u ON u.id = o.user_id
                WHERE o.conv_id = c.id AND o.user_id <> ? LIMIT 1) AS peer_nick,
              (SELECT o.user_id FROM conversation_member o
                WHERE o.conv_id = c.id AND o.user_id <> ? LIMIT 1) AS peer_id
         FROM conversation c
         JOIN conversation_member m ON m.conv_id = c.id AND m.user_id = ?
         LEFT JOIN message x ON x.conv_id = c.id
        GROUP BY c.id
        ORDER BY COALESCE(MAX(x.created_at), c.updated_at) DESC
        LIMIT ?`,
      userId, userId, userId, clampLimit(limit, 100),
    );
    if (!rows.length) return [];
    const unread = await this.unreadCounts(userId);
    return rows.map((r) => ({ ...r, unread: unread[r.id] || 0 }));
  }

  /** Unread per conversation for one viewer, in one query. */
  async unreadCounts(userId) {
    const rows = await this.rows(
      `SELECT m.conv_id, COUNT(*) AS n
         FROM conversation_member m JOIN message x ON x.conv_id = m.conv_id
        WHERE m.user_id = ? AND x.created_at > m.last_read_at
          AND x.user_id <> ? AND x.deleted_at IS NULL AND m.muted = 0
        GROUP BY m.conv_id`,
      userId, userId,
    );
    return Object.fromEntries(rows.map((r) => [r.conv_id, r.n]));
  }

  /** Public channels, for the browse list. Never returns dms or groups. */
  async listChannels({ limit = 30, offset = 0 } = {}) {
    return this.rows(
      `SELECT c.*, (SELECT COUNT(*) FROM conversation_member z WHERE z.conv_id = c.id) AS members,
              (SELECT COUNT(*) FROM message x WHERE x.conv_id = c.id) AS messages,
              (SELECT MAX(created_at) FROM message x WHERE x.conv_id = c.id) AS last_at
         FROM conversation c
        WHERE c.kind = 'channel' AND c.discoverable = 1
        ORDER BY COALESCE(last_at, c.updated_at) DESC
        LIMIT ? OFFSET ?`,
      clampLimit(limit, 50), Math.max(0, offset),
    );
  }

  /* messages */

  async addMessage({ convId, userId, body = '', game = null, at = Date.now() }) {
    const id = msgId();
    const g = game || { id: '', name: '', cover: '' };
    await this.db
      .prepare(
        `INSERT INTO message (id, conv_id, user_id, body, game_id, game_name, game_cover, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(id, convId, userId, body, g.id || '', g.name || '', g.cover || '', at)
      .run();
    await this.touchConversation(convId);
    return this.getMessage(id);
  }

  async getMessage(id) {
    return (await this.db.prepare('SELECT * FROM message WHERE id = ?').bind(id).first()) || null;
  }

  /**
   * History, newest first, with the author joined in. The caller reverses it for
   * display: a chat is written downwards, and paging reads naturally backwards.
   */
  async listMessages(convId, { limit = 50, before = null } = {}) {
    const cap = clampLimit(limit, 100);
    const rows = before
      ? await this.rows(
        `SELECT x.*, u.nick, u.popular, u.avatar_id
           FROM message x JOIN user u ON u.id = x.user_id
          WHERE x.conv_id = ? AND (x.created_at, x.id) < (SELECT created_at, id FROM message WHERE id = ?)
          ORDER BY x.created_at DESC, x.id DESC LIMIT ?`,
        convId, before, cap,
      )
      : await this.rows(
        `SELECT x.*, u.nick, u.popular, u.avatar_id
           FROM message x JOIN user u ON u.id = x.user_id
          WHERE x.conv_id = ?
          ORDER BY x.created_at DESC, x.id DESC LIMIT ?`,
        convId, cap,
      );
    return rows;
  }

  /**
   * Takes a message down without removing the row. The conversation keeps its
   * shape - which matters more than it sounds, because a member counting the
   * replies they received should not see the thread collapse - and the author
   * learns their message was removed instead of watching it disappear.
   */
  async softDeleteMessage(id, byUserId, at = Date.now()) {
    await this.db
      .prepare('UPDATE message SET deleted_at = ?, deleted_by = ?, body = ? WHERE id = ?')
      .bind(at, byUserId, '', id)
      .run();
    return this.getMessage(id);
  }

  /**
   * Removes a message that never had anything in it.
   *
   * A file-only message is created before its upload, so an upload that fails
   * leaves a row with no words and no files behind. There is nothing to redact
   * and nobody to protect - it was never readable - so the row goes rather than
   * leaving a "deleted message" notice in the room on every reload. A row that
   * has either words or files keeps the ordinary soft delete, because that one
   * was read by somebody.
   */
  async removeEmptyMessage(id) {
    const row = await this.db
      .prepare('SELECT id, body FROM message WHERE id = ? AND deleted_at IS NULL')
      .bind(id)
      .first();
    if (!row || String(row.body || '').trim()) return null;
    const files = await this.db
      .prepare('SELECT COUNT(*) AS n FROM message_file WHERE message_id = ?')
      .bind(id)
      .first();
    if (Number(files?.n || 0) > 0) return null;
    await this.db.prepare('DELETE FROM message WHERE id = ?').bind(id).run();
    return { id, removed: true };
  }

  async addMessageFile(file) {
    await this.db
      .prepare(
        `INSERT INTO message_file (id, message_id, name, mime, size, sha256, author, store, url, rid, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        file.id, file.message_id, file.name, file.mime, file.size, file.sha256, file.author,
        file.store || 'kv', file.url || '', file.rid || '', file.created_at,
      )
      .run();
    return (await this.db
      .prepare('SELECT * FROM message_file WHERE id = ?')
      .bind(file.id)
      .first()) || null;
  }

  async getMessageFile(id) {
    return (await this.db.prepare('SELECT * FROM message_file WHERE id = ?').bind(id).first()) || null;
  }

  async listMessageFiles(messageId) {
    return this.rows('SELECT * FROM message_file WHERE message_id = ? ORDER BY created_at ASC', messageId);
  }

  async listFilesForConversation(convId) {
    return this.rows(
      `SELECT f.* FROM message_file f JOIN message m ON m.id = f.message_id WHERE m.conv_id = ?`,
      convId,
    );
  }

  /* tickets */

  async createTicket({ convId, userId, tokenHash, expiresAt, at = Date.now() }) {
    const id = `t${tokenHash.slice(0, 15)}`;
    await this.db
      .prepare('INSERT INTO chat_ticket (id, conv_id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, convId, userId, tokenHash, expiresAt, at)
      .run();
    return id;
  }

  /**
   * Spends a ticket exactly once.
   *
   * The signature proves the ticket was minted by this Worker; the row proves it
   * has not been spent yet. Signature alone would allow a replay for the whole
   * minute it is valid, and `used_at IS NULL` in the WHERE clause is what makes
   * two simultaneous connects race for it - only one of them changes a row.
   */
  async spendTicket(id, tokenHash, at = Date.now()) {
    const res = await this.db
      .prepare(
        `UPDATE chat_ticket SET used_at = ?
          WHERE id = ? AND token_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .bind(at, id, tokenHash, at)
      .run();
    return (res?.meta?.changes || 0) > 0;
  }

  async ticketRow(id) {
    return (await this.db.prepare('SELECT * FROM chat_ticket WHERE id = ?').bind(id).first()) || null;
  }

  async dropExpiredTickets(at = Date.now()) {
    const res = await this.db.prepare('DELETE FROM chat_ticket WHERE expires_at <= ?').bind(at).run();
    return (res?.meta?.changes || 0) || 0;
  }

  /* per-conversation sanctions */

  /**
   * Mutes and kicks are per-conversation rather than account-wide: someone
   * shouted down in one channel has not earned a ban from the whole site, and a
   * global sanction for a local problem teaches people to stop talking rather
   * than to behave.
   */
  async addTakedown({ convId, userId, action, byUserId, reason = '', at = Date.now() }) {
    const id = takedownId();
    await this.db
      .prepare(
        'INSERT INTO message_takedown (id, conv_id, user_id, action, by_user_id, reason, created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .bind(id, convId, userId, action, byUserId, reason, at)
      .run();
    return id;
  }

  async takedownsFor(convId, userId) {
    return this.rows(
      'SELECT * FROM message_takedown WHERE conv_id = ? AND user_id = ?',
      convId, userId,
    );
  }

  /**
   * Sets a sanction, or clears it when `action` is null.
   *
   * Clearing deletes the row rather than appending an "unmute": a log that can
   * only grow cannot answer "is this person muted right now" without reading it
   * all, and a moderator who regrets a mute has to be able to lift it.
   */
  async setSanction(convId, userId, action, { byUserId = '', reason = '', at = Date.now() } = {}) {
    if (!action) {
      await this.db
        .prepare('DELETE FROM message_takedown WHERE conv_id = ? AND user_id = ? AND action = ?')
        .bind(convId, userId, 'mute')
        .run();
      return null;
    }
    await this.db
      .prepare('DELETE FROM message_takedown WHERE conv_id = ? AND user_id = ? AND action = ?')
      .bind(convId, userId, action)
      .run();
    return this.addTakedown({ convId, userId, action, byUserId, reason, at });
  }

  /** True when this person is muted or kicked out of this conversation. */
  async sanctionOf(convId, userId) {
    const rows = await this.takedownsFor(convId, userId);
    if (rows.some((r) => r.action === 'kick')) return 'kick';
    if (rows.some((r) => r.action === 'mute')) return 'mute';
    return '';
  }
}