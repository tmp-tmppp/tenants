import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { Clock, IdGenerator } from "../usecases/ports.js";

export const systemClock: Clock = { now: () => new Date() };

/** Ids are UUIDv7 generated here, not by the database; invite codes are 24 random bytes in base64url. */
export const randomIds: IdGenerator = {
  newId: () => uuidv7(),
  newInviteCode: () => randomBytes(24).toString("base64url"),
};
