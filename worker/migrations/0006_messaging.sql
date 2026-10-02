-- Messaging: channels, groups and direct chats between friends.
--
-- Three kinds, one table, because they differ only in who may read and who may
-- post - and encoding that difference in the row is what lets the permission
-- checks stay one function instead of three parallel implementations that drift.
--
--   dm      - exactly two people, created on demand. Only mutual followers can
--             open one, so a stranger cannot start a conversation with someone
--             who never asked for it. Telegram and Discord both gate DMs this
--             way, and without the gate this site - which allows anonymous
--             posting - would become an unlisted way to message anyone.
--   channel - readable by everyone on the site, writable only by subscribers.
--             This is a broadcast surface: one author, many readers.
--   group   - private, invitation only, every member writes.
--
-- Bodies live in D1 rather than in the Durable Object. The DO only fans out
-- messages that are already stored, so every ban, quota, throttle and sanitiser
-- check stays on the path that already has them, and a dead socket costs
-- delivery rather than the message. It also means history survives a DO being
-- evicted, and moderation can read a chat the same way it reads a post.

CREATE TABLE IF NOT EXISTS conversation (
  id          TEXT PRIMARY KEY,
  -- 'dm' | 'channel' | 'group'
  kind        TEXT NOT NULL,
  -- Only channels and groups have a name; a dm is titled from its other side,
  -- because two people know who they are talking to without a label.
  title       TEXT NOT NULL DEFAULT '',
  topic       TEXT NOT NULL DEFAULT '',
  -- The account that created it. A dm's owner is meaningless (both sides can
  -- leave) but it is still recorded so "my conversations" has an author.
  owner       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  -- A channel is the only kind anybody can read without joining, so it needs an
  -- explicit note about that. A closed channel is discoverable but not
  -- joinable, and a public group is not a thing: groups are private by design.
  discoverable INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_kind ON conversation (kind, updated_at DESC);

-- The dm pairing. A dm between the same two people must not be creatable twice,
-- and without a unique pair row the natural key is only implied by the member
-- list, which two concurrent requests can both be building.
CREATE TABLE IF NOT EXISTS conversation_pair (
  a         TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  b         TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  conv_id   TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS idx_pair_conv ON conversation_pair (conv_id);
CREATE INDEX IF NOT EXISTS idx_pair_b ON conversation_pair (b);

CREATE TABLE IF NOT EXISTS conversation_member (
  conv_id      TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  -- 'owner' | 'mod' | 'member'
  role         TEXT NOT NULL DEFAULT 'member',
  joined_at    INTEGER NOT NULL,
  -- The last message this member has actually seen. One integer per member
  -- rather than a read receipt table: unread counts are the only thing that
  -- needs it, and a per-message receipt would grow without bound.
  last_read_at INTEGER NOT NULL DEFAULT 0,
  -- Muted members still receive messages but do not count toward unread.
  muted        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conv_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_member_user ON conversation_member (user_id, joined_at DESC);

CREATE TABLE IF NOT EXISTS message (
  id       TEXT PRIMARY KEY,
  conv_id  TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  -- Plain text. The client renders it as a text node, so there is no markup to
  -- sanitise here, and the column holds no HTML by construction.
  body     TEXT NOT NULL DEFAULT '',
  -- Set when a moderator takes the message down. The row is kept rather than
  -- deleted so the conversation keeps its shape and the author can see their own
  -- message was removed instead of watching it vanish.
  deleted_at INTEGER,
  deleted_by TEXT,
  -- An optional game this message is about, reusing the item's free-form game
  -- fields. A dm about a cheat is the exact reason this feature exists.
  game_id    TEXT NOT NULL DEFAULT '',
  game_name  TEXT NOT NULL DEFAULT '',
  game_cover TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
-- History is read newest-first for one conversation, which is exactly this
-- index, and the id tiebreak matters because messages created in the same
-- millisecond must still page in a stable order.
CREATE INDEX IF NOT EXISTS idx_message_conv ON message (conv_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_message_user ON message (user_id, created_at DESC);

-- Attachments reuse the item upload path: same Cloudinary routing, same denylist
-- plugin, same store column. `message_id` is the only thing that differs, so an
-- attachment is stored and destroyed by code that already exists.
CREATE TABLE IF NOT EXISTS message_file (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  author     TEXT NOT NULL,
  store      TEXT NOT NULL DEFAULT 'kv',
  url        TEXT NOT NULL DEFAULT '',
  rid        TEXT NOT NULL DEFAULT '',
  downloads  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_file_msg ON message_file (message_id, created_at);

-- A ban has to reach messages that were already delivered, and the same is true
-- of a takedown report. Keeping this separate from the account ban means a
-- message-only sanction does not require a fake account row.
CREATE TABLE IF NOT EXISTS message_takedown (
  id         TEXT PRIMARY KEY,
  conv_id    TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  -- 'mute' | 'kick'
  action     TEXT NOT NULL,
  by_user_id TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_takedown_conv ON message_takedown (conv_id, user_id);

-- One-shot WebSocket tickets. The browser cannot set a header on a WebSocket
-- handshake, so a signed ticket is minted over HTTPS and spent on connect.
-- Rows exist so a ticket can be spent exactly once and so an unspent ticket can
-- be revoked by deleting it, rather than trusting a signature alone.
CREATE TABLE IF NOT EXISTS chat_ticket (
  id         TEXT PRIMARY KEY,
  conv_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  -- Only sha256 of the ticket is stored, for the same reason session tokens are:
  -- a leaked database must not hand out live connections.
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_conv ON chat_ticket (conv_id);