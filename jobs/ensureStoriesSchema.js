const { execute } = require('../config/database');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS stories (
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
  ) WITH CLUSTERING ORDER BY (created_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories (expires_at)`,

  `CREATE TABLE IF NOT EXISTS stories_by_id (
    story_id uuid PRIMARY KEY,
    user_id uuid,
    media_type text,
    media_url text,
    caption text,
    background text,
    duration int,
    created_at timestamp,
    expires_at timestamp
  )`,

  `CREATE TABLE IF NOT EXISTS story_views (
    story_id uuid,
    viewer_id uuid,
    viewed_at timestamp,
    PRIMARY KEY ((story_id), viewer_id)
  )`,

  `CREATE TABLE IF NOT EXISTS story_reactions (
    story_id uuid,
    reactor_id uuid,
    emoji text,
    created_at timestamp,
    PRIMARY KEY ((story_id), reactor_id)
  )`,
];

async function ensureStoriesSchema() {
  for (const query of STATEMENTS) {
    try {
      await execute(query, [], { prepare: false });
    } catch (err) {
      // Index déjà existant / race au démarrage : ignorable
      if (/already exists/i.test(err.message || '')) continue;
      console.error('ensureStoriesSchema:', err.message);
      throw err;
    }
  }
  console.log('✅ Schéma stories prêt');
}

module.exports = { ensureStoriesSchema };
