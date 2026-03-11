const { MongoClient, GridFSBucket, ObjectId } = require("mongodb");
const config = require("../config");

let client = null;
let database = null;
const buckets = new Map();

async function getMongoClient() {
  if (client) return client;
  if (!config.mongoUri) {
    throw new Error("MONGO_URI 未配置");
  }
  client = new MongoClient(config.mongoUri, { ignoreUndefined: true });
  await client.connect();
  database = client.db();
  return client;
}

async function getMongoDb() {
  if (!database) {
    await getMongoClient();
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
