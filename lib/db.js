import { MongoClient } from "mongodb";
import fs from "fs";
import path from "path";
import { hashPassword } from "./auth";

const DEFAULT_TALLY = {
  company: "Gurmeet Motors Pvt Ltd - Ranchi",
  cash: "Cash",
  bank: "Bank",
  cheque: "Cheque in Hand",
  salesReturn: "Sales Return",
  discount: "Discount Allowed",
  other: "Other Adjustments",
  bankAlloc: true,
};

const SYNC_KEYS = ["users", "parties", "bills", "allocs", "collections", "advAdj", "audit", "tombstones", "expBatches", "logs"];

// Local persistence fallback
const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "db.json");

function ensureLocalDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getInitialDb() {
  const adminPass = process.env.DEFAULT_ADMIN_PASSWORD || "admin123";
  const adminUser = process.env.DEFAULT_ADMIN_USERNAME || "admin";
  return {
    users: [
      {
        id: 1,
        username: adminUser.toLowerCase(),
        password: hashPassword(adminPass),
        name: "Administrator",
        role: "admin",
        loc: "Ranchi (HO)",
        active: true,
        mustChange: false,
      },
      {
        id: 2,
        username: "accounts",
        password: hashPassword("accounts123"),
        name: "Accounts Officer",
        role: "accounts",
        loc: "Ranchi (HO)",
        active: true,
        mustChange: false,
      },
      {
        id: 3,
        username: "sales",
        password: hashPassword("sales123"),
        name: "Ajay (Salesman)",
        role: "salesman",
        loc: "Ranchi (HO)",
        active: true,
        mustChange: false,
      },
    ],
    parties: [],
    bills: [],
    allocs: [],
    collections: [],
    advAdj: [],
    audit: [],
    tombstones: [],
    expBatches: [],
    logs: [],
    advSeq: 0,
    tally: { ...DEFAULT_TALLY },
  };
}

function readLocalDb() {
  ensureLocalDir();
  if (fs.existsSync(DATA_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      return { ...getInitialDb(), ...parsed };
    } catch (e) {
      console.error("Error reading local db file, using fresh initial db:", e.message);
    }
  }
  const init = getInitialDb();
  writeLocalDb(init);
  return init;
}

function writeLocalDb(data) {
  ensureLocalDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

let cachedClient = null;
let mongoDbInstance = null;
let isMongoConnecting = false;
let mongoStatus = "uninitialized";

async function getMongoClient() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    mongoStatus = "no_uri";
    return null;
  }
  if (mongoDbInstance) return mongoDbInstance;
  if (isMongoConnecting) return null;

  isMongoConnecting = true;
  try {
    cachedClient = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    await cachedClient.connect();
    // Default to 'gmtsaleserp' database
    mongoDbInstance = cachedClient.db("gmtsaleserp");
    mongoStatus = "connected";
    console.log("✅ [MongoDB] Connected successfully to Atlas cluster (database: gmtsaleserp)");
    await seedMongoIfNeeded(mongoDbInstance);
    return mongoDbInstance;
  } catch (err) {
    mongoStatus = "error";
    console.warn(`⚠️ [MongoDB] Atlas connection could not be established: ${err.message}`);
    console.warn("ℹ️  Running in local JSON fallback mode (.data/db.json). If using Atlas, ensure your current IP (49.47.134.12 or 0.0.0.0/0) is in Atlas Network Access IP Whitelist.");
    return null;
  } finally {
    isMongoConnecting = false;
  }
}

async function seedMongoIfNeeded(db) {
  try {
    const usersCol = db.collection("users");
    const count = await usersCol.countDocuments();
    if (count === 0) {
      const initial = readLocalDb();
      for (const key of SYNC_KEYS) {
        if (initial[key]?.length) {
          await db.collection(key).insertMany(initial[key]);
        }
      }
      await db.collection("settings").updateOne(
        { _id: "state" },
        { $set: { tally: initial.tally, advSeq: initial.advSeq } },
        { upsert: true }
      );
      console.log("🌱 [MongoDB] Database initialized with seed data and default users.");
    }
  } catch (e) {
    console.error("Error seeding MongoDB:", e.message);
  }
}

export async function findUserByUsername(username) {
  const un = (username || "").trim().toLowerCase();
  const db = await getMongoClient();
  if (db) {
    try {
      const user = await db.collection("users").findOne({ username: un });
      return user || null;
    } catch (e) {
      console.error("MongoDB query error:", e.message);
    }
  }
  const local = readLocalDb();
  return local.users.find((u) => u.username.toLowerCase() === un) || null;
}

export async function findUserById(id) {
  const db = await getMongoClient();
  if (db) {
    try {
      const user = await db.collection("users").findOne({ id: Number(id) });
      return user || null;
    } catch (e) {
      console.error("MongoDB query error:", e.message);
    }
  }
  const local = readLocalDb();
  return local.users.find((u) => u.id === Number(id)) || null;
}

export async function updateUserPassword(userId, newPasswordHash) {
  const db = await getMongoClient();
  if (db) {
    try {
      await db.collection("users").updateOne(
        { id: Number(userId) },
        { $set: { password: newPasswordHash, mustChange: false } }
      );
    } catch (e) {
      console.error("MongoDB update password error:", e.message);
    }
  }
  const local = readLocalDb();
  local.users = local.users.map((u) =>
    u.id === Number(userId) ? { ...u, password: newPasswordHash, mustChange: false } : u
  );
  writeLocalDb(local);
  return true;
}

export async function getState(currentUser) {
  const db = await getMongoClient();
  if (db) {
    try {
      const stateObj = {
        me: {
          id: currentUser.id,
          username: currentUser.username,
          name: currentUser.name,
          role: currentUser.role,
          loc: currentUser.loc,
          mustChange: !!currentUser.mustChange,
        },
      };

      for (const k of SYNC_KEYS) {
        const docs = await db.collection(k).find({}, { projection: { _id: 0 } }).toArray();
        stateObj[k] = docs || [];
      }

      const settings = await db.collection("settings").findOne({ _id: "state" });
      stateObj.tally = settings?.tally || { ...DEFAULT_TALLY };
      stateObj.advSeq = settings?.advSeq || 0;

      return stateObj;
    } catch (e) {
      console.error("MongoDB getState error, falling back to local:", e.message);
    }
  }

  const local = readLocalDb();
  return {
    me: {
      id: currentUser.id,
      username: currentUser.username,
      name: currentUser.name,
      role: currentUser.role,
      loc: currentUser.loc,
      mustChange: !!currentUser.mustChange,
    },
    ...local,
  };
}

export async function applySyncOps(ops, currentUser) {
  const errors = [];
  const patchedCollections = [];

  const db = await getMongoClient();
  const local = readLocalDb();

  for (const op of ops) {
    if (op.tally) {
      local.tally = { ...local.tally, ...op.tally };
      if (db) {
        try {
          await db.collection("settings").updateOne(
            { _id: "state" },
            { $set: { tally: local.tally } },
            { upsert: true }
          );
        } catch (e) {
          errors.push(`Tally settings update error: ${e.message}`);
        }
      }
    }

    if (op.advSeq !== undefined) {
      local.advSeq = Math.max(local.advSeq || 0, Number(op.advSeq) || 0);
      if (db) {
        try {
          await db.collection("settings").updateOne(
            { _id: "state" },
            { $set: { advSeq: local.advSeq } },
            { upsert: true }
          );
        } catch (e) {
          errors.push(`Advance sequence update error: ${e.message}`);
        }
      }
    }

    if (op.c && SYNC_KEYS.includes(op.c)) {
      const key = op.c;
      const col = db ? db.collection(key) : null;

      // Handle deletions
      if (Array.isArray(op.del) && op.del.length) {
        const delSet = new Set(op.del);
        local[key] = (local[key] || []).filter((item) => !delSet.has(item.id));
        if (col) {
          try {
            await col.deleteMany({ id: { $in: op.del } });
          } catch (e) {
            errors.push(`Delete from ${key} error: ${e.message}`);
          }
        }
      }

      // Handle upserts
      if (Array.isArray(op.upsert) && op.upsert.length) {
        for (const item of op.upsert) {
          // If this is a user and has password updated, hash it
          if (key === "users" && item.password && !item.password.includes(":")) {
            item.password = hashPassword(item.password);
          }

          // If this is a collection with advance reference, check advSeq
          if (key === "collections" && item.advRef && item.advRef.startsWith("ADV-")) {
            const seqNum = parseInt(item.advRef.replace("ADV-", ""), 10);
            if (!isNaN(seqNum) && seqNum > (local.advSeq || 0)) {
              local.advSeq = seqNum;
              if (db) {
                await db.collection("settings").updateOne(
                  { _id: "state" },
                  { $set: { advSeq: local.advSeq } },
                  { upsert: true }
                );
              }
            }
          }

          // Update local memory
          const existingIdx = (local[key] || []).findIndex((x) => x.id === item.id);
          if (existingIdx >= 0) {
            local[key][existingIdx] = { ...local[key][existingIdx], ...item };
          } else {
            local[key] = [...(local[key] || []), item];
          }

          // Update Mongo
          if (col) {
            try {
              const { _id, ...cleanItem } = item;
              await col.updateOne({ id: cleanItem.id }, { $set: cleanItem }, { upsert: true });
            } catch (e) {
              errors.push(`Upsert to ${key} error: ${e.message}`);
            }
          }
        }
      }
    }
  }

  writeLocalDb(local);

  return {
    ok: true,
    patched: {
      collections: patchedCollections,
    },
    errors,
  };
}

