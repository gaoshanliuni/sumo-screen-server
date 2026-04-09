const { MongoClient, GridFSBucket, ObjectId } = require("mongodb");
const config = require("../config");

let client = null;
let database = null;
let connectPromise = null;
const buckets = new Map();

async function getMongoClient() {
  if (client && database) return client;
  if (connectPromise) {
    await connectPromise;
    return client;
  }

  if (!config.mongoUri) {
    throw new Error("MONGO_URI is not configured");
  }

  if (!client) {
    client = new MongoClient(config.mongoUri, { ignoreUndefined: true });
  }

  connectPromise = (async () => {
    await client.connect();
    database = client.db();
    if (!database) {
      throw new Error("Mongo db handle is not ready");
    }
    buckets.clear();
  })();

  try {
    await connectPromise;
  } catch (error) {
    try {
      await client?.close();
    } catch (_) {
      // ignore close errors
    }
    client = null;
    database = null;
    buckets.clear();
    throw error;
  } finally {
    connectPromise = null;
  }

  return client;
}

async function getMongoDb() {
  if (database) {
    return database;
  }
  await getMongoClient();
  if (!database) {
    throw new Error("Mongo db handle is not ready");
  }
  return database;
}

async function getGridBucket(bucketName = "tf_files") {
  if (!buckets.has(bucketName)) {
    const db = await getMongoDb();
    buckets.set(bucketName, new GridFSBucket(db, { bucketName }));
  }
  return buckets.get(bucketName);
}

module.exports = {
  getMongoClient,
  getMongoDb,
  getGridBucket,
  ObjectId,
};
