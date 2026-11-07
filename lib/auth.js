import crypto from "crypto";

const SECRET = process.env.SESSION_SECRET || process.env.JWT_SECRET || "gmtsaleserp-secret-key-at-least-32-chars-long";

export function hashPassword(password) {
  if (!password) return "";
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  // If stored is plain text (legacy / direct assignment)
  if (!stored.includes(":")) {
    return password === stored;
  }
  try {
    const [salt, hash] = stored.split(":");
    const testHash = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(testHash, "hex"));
  } catch {
    return password === stored;
  }
}

export function createSessionToken(user) {
  const payload = {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    loc: user.loc,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
  };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
  return `${data}.${signature}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, signature] = parts;
  const expectedSignature = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
  if (signature !== expectedSignature) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function getSessionFromRequest(request) {
  let token = null;
  const authHeader = request.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  } else {
    const cookieHeader = request.headers.get("cookie") || "";
    const match = cookieHeader.match(/session_token=([^;]+)/);
    if (match) token = match[1];
  }
  return verifySessionToken(token);
}

