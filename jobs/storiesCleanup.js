const path = require('path');
const fs = require('fs');
const config = require('../config');
const { execute } = require('../config/database');

/**
 * Supprime les statuts expirés (média + Cassandra).
 * Cassandra : index secondaire sur expires_at + ALLOW FILTERING (OK à petite échelle).
 */
async function cleanupExpiredStories() {
  try {
    const now = new Date();
    const expired = await execute(
      'SELECT story_id, user_id, media_url, created_at, expires_at FROM stories WHERE expires_at < ? ALLOW FILTERING',
      [now]
    );

    let removed = 0;
    for (const row of expired.rows) {
      const storyId = row.story_id;
      const userId = row.user_id;
      const createdAt = row.created_at;

      if (row.media_url) {
        const rel = String(row.media_url).replace(/^\/uploads\//, '');
        const filePath = path.join(config.uploadDir, rel);
        fs.unlink(filePath, () => {});
      }

      try {
        await execute(
          'DELETE FROM stories WHERE user_id = ? AND created_at = ? AND story_id = ?',
          [userId, createdAt, storyId]
        );
        await execute('DELETE FROM stories_by_id WHERE story_id = ?', [storyId]);
        await execute('DELETE FROM story_views WHERE story_id = ?', [storyId]);
        await execute('DELETE FROM story_reactions WHERE story_id = ?', [storyId]).catch(() => {});
        removed += 1;
      } catch (err) {
        console.warn('story cleanup delete failed:', storyId, err.message);
      }
    }

    if (removed > 0) {
      console.log(`🧹 Stories cleanup: ${removed} statut(s) expiré(s) supprimé(s)`);
    }
  } catch (err) {
    console.error('stories cleanup error:', err.message);
  }
}

function startStoriesCleanupJob() {
  // Démarrage différé puis toutes les heures
  setTimeout(() => cleanupExpiredStories(), 15_000);
  setInterval(() => cleanupExpiredStories(), 60 * 60 * 1000);
}

module.exports = { cleanupExpiredStories, startStoriesCleanupJob };
