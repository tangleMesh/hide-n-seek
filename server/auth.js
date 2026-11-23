import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { COLORS } from '../shared/constants.js';

const scryptAsync = promisify(scrypt);

export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const buf = await scryptAsync(String(password), salt, 32);
  return { salt, pwHash: buf.toString('hex') };
}

export async function verifyPassword(password, salt, pwHash) {
  if (!salt || !pwHash) return false;
  const buf = await scryptAsync(String(password), salt, 32);
  const want = Buffer.from(pwHash, 'hex');
  return want.length === buf.length && timingSafeEqual(buf, want);
}

export const NAME_RE = /^[A-Za-z0-9_.-]{3,16}$/;

export function validateCredentials(name, password) {
  if (!NAME_RE.test(String(name || ''))) return 'Name must be 3-16 characters: letters, digits, _ . -';
  if (String(password || '').length < 6) return 'Password must be at least 6 characters';
  return null;
}

export async function register(repos, name, password) {
  const err = validateCredentials(name, password);
  if (err) return { error: err };
  if (await repos.users.nameTaken(name)) return { error: 'Name already taken' };
  const { salt, pwHash } = await hashPassword(password);
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  let user;
  try {
    user = await repos.users.create({ name, salt, pwHash, color });
  } catch (e) {
    if (e.code === 11000) return { error: 'Name already taken' };
    throw e;
  }
  const token = await repos.sessions.create(user._id);
  return { user, token };
}

export async function login(repos, name, password) {
  const user = await repos.users.byName(name);
  if (!user || user.kind !== 'human' || !(await verifyPassword(password, user.salt, user.pwHash))) {
    return { error: 'Wrong name or password' };
  }
  const token = await repos.sessions.create(user._id);
  return { user, token };
}

export async function userFromToken(repos, token) {
  const s = await repos.sessions.find(token);
  if (!s) return null;
  return repos.users.byId(s.userId);
}

export function tokenFromRequest(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)hush_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
