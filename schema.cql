-- WhatsApp Clone - Cassandra Schema (corrigé)
-- Run this in cqlsh

CREATE KEYSPACE IF NOT EXISTS whatsapp_clone
WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

USE whatsapp_clone;

-- ==================== USERS ====================
CREATE TABLE IF NOT EXISTS users (
    user_id uuid,
    username text,
    email text,
    password_hash text,
    full_name text,
    avatar_url text,
    status_text text,
    hide_online boolean,
    hide_last_seen boolean,
    is_online boolean,
    last_seen timestamp,
    created_at timestamp,
    updated_at timestamp,
    PRIMARY KEY (user_id)
);

-- Lookup by username (enrichi pour la recherche)
CREATE TABLE IF NOT EXISTS users_by_username (
    username text,
    user_id uuid,
    full_name text,
    avatar_url text,
    PRIMARY KEY (username)
);

-- Lookup by email
CREATE TABLE IF NOT EXISTS users_by_email (
    email text,
    user_id uuid,
    PRIMARY KEY (email)
);

-- ==================== PASSWORD RESET ====================
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token text,
    user_id uuid,
    expires_at timestamp,
    PRIMARY KEY (token)
);

-- ==================== CONVERSATIONS ====================
CREATE TABLE IF NOT EXISTS conversations (
    conversation_id uuid,
    type text,
    name text,
    description text,
    avatar_url text,
    created_by uuid,
    created_at timestamp,
    updated_at timestamp,
    PRIMARY KEY (conversation_id)
);

CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id uuid,
    user_id uuid,
    role text,
    joined_at timestamp,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_conversations (
    user_id uuid,
    conversation_id uuid,
    type text,
    last_read_at timestamp,
    archived boolean,
    PRIMARY KEY (user_id, conversation_id)
);

-- ==================== MESSAGES ====================
CREATE TABLE IF NOT EXISTS messages (
    conversation_id uuid,
    message_id timeuuid,
    sender_id uuid,
    content text,
    message_type text,
    file_url text,
    file_name text,
    file_size bigint,
    mime_type text,
    duration int,
    reply_to_id timeuuid,
    is_edited boolean,
    is_deleted boolean,
    deleted_for_everyone boolean,
    is_ephemeral boolean,
    expires_at timestamp,
    created_at timestamp,
    updated_at timestamp,
    PRIMARY KEY (conversation_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- Index par contenu pour recherche
CREATE TABLE IF NOT EXISTS messages_by_content (
    conversation_id uuid,
    message_id timeuuid,
    content text,
    sender_id uuid,
    created_at timestamp,
    PRIMARY KEY (conversation_id, message_id)
);

-- ==================== READ RECEIPTS ====================
CREATE TABLE IF NOT EXISTS message_read_receipts (
    conversation_id uuid,
    message_id timeuuid,
    user_id uuid,
    read_at timestamp,
    PRIMARY KEY (conversation_id, message_id, user_id)
);

-- ==================== BLOCKED USERS ====================
CREATE TABLE IF NOT EXISTS blocked_users (
    blocker_id uuid,
    blocked_id uuid,
    created_at timestamp,
    PRIMARY KEY (blocker_id, blocked_id)
);

-- ==================== CALLS ====================
CREATE TABLE IF NOT EXISTS call_history (
    call_id uuid,
    conversation_id uuid,
    caller_id uuid,
    caller_peer_id text,
    call_type text,
    status text,
    duration int,
    started_at timestamp,
    ended_at timestamp,
    created_at timestamp,
    PRIMARY KEY (call_id)
);

CREATE TABLE IF NOT EXISTS call_history_by_conversation (
    conversation_id uuid,
    created_at timestamp,
    call_id uuid,
    caller_id uuid,
    call_type text,
    status text,
    duration int,
    PRIMARY KEY (conversation_id, created_at)
) WITH CLUSTERING ORDER BY (created_at DESC);

CREATE TABLE IF NOT EXISTS call_history_by_user (
    user_id uuid,
    created_at timestamp,
    call_id uuid,
    conversation_id uuid,
    caller_id uuid,
    call_type text,
    status text,
    duration int,
    PRIMARY KEY (user_id, created_at)
) WITH CLUSTERING ORDER BY (created_at DESC);

-- Sessions d'appel actives / historique enrichi (1-à-1 + groupe mesh)
CREATE TABLE IF NOT EXISTS call_sessions (
    call_id uuid,
    conversation_id uuid,
    initiator_id uuid,
    call_type text,
    status text,
    started_at timestamp,
    ended_at timestamp,
    PRIMARY KEY (call_id)
);

CREATE TABLE IF NOT EXISTS call_participants (
    call_id uuid,
    user_id uuid,
    joined_at timestamp,
    left_at timestamp,
    status text,
    PRIMARY KEY (call_id, user_id)
);

-- ==================== NOTIFICATIONS ====================
CREATE TABLE IF NOT EXISTS notifications (
    user_id uuid,
    notification_id uuid,
    type text,
    title text,
    body text,
    conversation_id uuid,
    actor_id uuid,
    is_read boolean,
    created_at timestamp,
    PRIMARY KEY (user_id, notification_id)
);

CREATE TABLE IF NOT EXISTS notifications_by_user_date (
    user_id uuid,
    created_at timestamp,
    notification_id uuid,
    type text,
    title text,
    body text,
    conversation_id uuid,
    actor_id uuid,
    is_read boolean,
    PRIMARY KEY (user_id, created_at, notification_id)
) WITH CLUSTERING ORDER BY (created_at DESC);

CREATE TABLE IF NOT EXISTS unread_notifications_count (
    user_id uuid,
    count counter,
    PRIMARY KEY (user_id)
);

-- ==================== MESSAGE REACTIONS ====================
-- One row per (message, user, emoji). App enforces one emoji per user per message.
CREATE TABLE IF NOT EXISTS message_reactions (
    message_id timeuuid,
    user_id uuid,
    emoji text,
    created_at timestamp,
    PRIMARY KEY ((message_id), user_id, emoji)
);

-- ==================== STORIES / STATUTS 24H ====================
-- Statuts publiés, partitionnés par auteur (liste chronologique)
CREATE TABLE IF NOT EXISTS stories (
    story_id uuid,
    user_id uuid,
    media_type text,
    media_url text,
    caption text,
    background text,
    duration int,
    created_at timestamp,
    expires_at timestamp,
    PRIMARY KEY ((user_id), created_at, story_id)
) WITH CLUSTERING ORDER BY (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories (expires_at);

-- Lookup par story_id (vue / suppression / viewers)
CREATE TABLE IF NOT EXISTS stories_by_id (
    story_id uuid PRIMARY KEY,
    user_id uuid,
    media_type text,
    media_url text,
    caption text,
    background text,
    duration int,
    created_at timestamp,
    expires_at timestamp
);

CREATE TABLE IF NOT EXISTS story_views (
    story_id uuid,
    viewer_id uuid,
    viewed_at timestamp,
    PRIMARY KEY ((story_id), viewer_id)
);

CREATE TABLE IF NOT EXISTS story_reactions (
    story_id uuid,
    reactor_id uuid,
    emoji text,
    created_at timestamp,
    PRIMARY KEY ((story_id), reactor_id)
);
