import mongoose from "mongoose";
import { DB, LOG_MESSAGES } from "./constants.js";

export async function connectDb(uri: string, dbName: string): Promise<void> {
  mongoose.set(DB.STRICT_QUERY_OPTION, true);
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: DB.SERVER_SELECTION_TIMEOUT_MS });
  console.log(LOG_MESSAGES.DB_CONNECTED(mongoose.connection.name));
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
