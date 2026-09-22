const cassandra = require('cassandra-driver');

let client = null;

async function getClient() {
  if (client) return client;

  const contactPoints = (process.env.CASSANDRA_CONTACT_POINTS || '127.0.0.1').split(',');
  const localDataCenter = process.env.CASSANDRA_LOCAL_DC || 'datacenter1';
  const keyspace = process.env.CASSANDRA_KEYSPACE || 'whatsapp_clone';

  client = new cassandra.Client({
    contactPoints,
    localDataCenter,
    keyspace,
    credentials: process.env.CASSANDRA_USERNAME
      ? { username: process.env.CASSANDRA_USERNAME, password: process.env.CASSANDRA_PASSWORD }
      : undefined,
    socketOptions: { connectTimeout: 10000, readTimeout: 12000 },
  });

  await client.connect();
  console.log('Connected to Cassandra cluster');
  return client;
}

async function execute(query, params = [], options = {}) {
  const c = await getClient();
  const result = await c.execute(query, params, { prepare: true, ...options });
  return result;
}

async function batch(queries) {
  const c = await getClient();
  const result = await c.batch(queries, { prepare: true });
  return result;
}

module.exports = { getClient, execute, batch };
