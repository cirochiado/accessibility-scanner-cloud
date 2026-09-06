import dns from 'node:dns/promises';
import net from 'node:net';

const LOCAL_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost']);

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

function inV4(ip, base, bits) {
  const x = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (x === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (x & mask) === (b & mask);
}

function ipv6Groups(ip) {
  let s = String(ip).toLowerCase().split('%')[0];
  // IPv4 embedded notation, e.g. ::ffff:127.0.0.1
  const m4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (m4) {
    const n = ipv4ToInt(m4[1]);
    if (n === null) return null;
    s = s.slice(0, m4.index) + `${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':').filter(Boolean) : [];
  if (parts.length === 1 && left.length !== 8) return null;
  if (left.length + right.length > 8) return null;
  const fill = parts.length === 2 ? Array(8 - left.length - right.length).fill('0') : [];
  const all = [...left, ...fill, ...right];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

export function isPublicIp(ip) {
  const family = net.isIP(ip);
  if (!family) return false;

  if (family === 4) {
    const denied = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.88.99.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ];
    return !denied.some(([base, bits]) => inV4(ip, base, bits));
  }

  const g = ipv6Groups(ip);
  if (!g) return false;
  const allZero = g.every((x) => x === 0);
  if (allZero) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation

  // IPv4-mapped ::ffff:a.b.c.d (anche in forma esadecimale) e vecchio
  // spazio IPv4-compatible ::/96: per un servizio anti-SSRF e' piu' sicuro
  // ricondurli all'IPv4 incorporato o rifiutare lo spazio ambiguo.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const embedded = `${g[6] >>> 8}.${g[6] & 255}.${g[7] >>> 8}.${g[7] & 255}`;
    return isPublicIp(embedded);
  }
  if (g.slice(0, 6).every((x) => x === 0)) return false;

  return true;
}

export function normalizeHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL non valido');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Sono consentiti solo URL http/https');
  if (u.username || u.password) throw new Error('Credenziali nell’URL non consentite');
  if (!u.hostname) throw new Error('Hostname mancante');
  u.hash = '';
  return u;
}

export async function validatePublicHttpUrl(raw, {
  allowPrivate = process.env.A11Y_ALLOW_PRIVATE === '1',
  resolveDns = true,
} = {}) {
  const u = normalizeHttpUrl(raw);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (allowPrivate) return u;
  if (LOCAL_NAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Hostname locale/privato non consentito');
  }

  const directFamily = net.isIP(host);
  if (directFamily && !isPublicIp(host)) throw new Error('Indirizzo IP locale/privato/riservato non consentito');

  if (resolveDns && !directFamily) {
    let answers;
    try {
      answers = await dns.lookup(host, { all: true, verbatim: true });
    } catch (err) {
      throw new Error(`DNS non risolvibile: ${err.code || err.message}`);
    }
    if (!answers.length) throw new Error('DNS senza indirizzi risolti');
    const bad = answers.find((a) => !isPublicIp(a.address));
    if (bad) throw new Error(`Hostname risolve a indirizzo locale/privato/riservato (${bad.address})`);
  }

  return u;
}

export function createPublicRequestGuard({
  allowPrivate = process.env.A11Y_ALLOW_PRIVATE === '1',
  ttlMs = 60_000,
} = {}) {
  const cache = new Map();
  return async function guard(raw) {
    let u;
    try { u = new URL(raw); } catch { return false; }
    if (['data:', 'blob:', 'about:'].includes(u.protocol)) return true;
    if (!['http:', 'https:'].includes(u.protocol)) return false;

    const key = `${u.protocol}//${u.host}`;
    const c = cache.get(key);
    if (c && Date.now() - c.at < ttlMs) return c.ok;
    try {
      await validatePublicHttpUrl(u.toString(), { allowPrivate, resolveDns: true });
      cache.set(key, { ok: true, at: Date.now() });
      return true;
    } catch {
      cache.set(key, { ok: false, at: Date.now() });
      return false;
    }
  };
}
