import { timingSafeEqual } from 'node:crypto';

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && A.length > 0 && timingSafeEqual(A, B);
}

export function requireApiToken(req) {
  const expected = process.env.A11Y_API_TOKEN;
  if (!expected) return { ok: false, status: 503, error: 'A11Y_API_TOKEN non configurato' };
  const auth = String(req.headers.get('authorization') || '');
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!safeEqual(expected, provided)) return { ok: false, status: 401, error: 'unauthorized' };
  return { ok: true };
}

export function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store', ...extraHeaders },
  });
}
