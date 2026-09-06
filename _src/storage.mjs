import { getStore } from '@netlify/blobs';

export const STORE_NAME = 'a11y-scanner-v07';
export function store() {
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

export async function getJson(key) {
  return await store().get(key, { type: 'json', consistency: 'strong' });
}

export async function setJson(key, value) {
  return await store().setJSON(key, value);
}

export async function setText(key, value, metadata = {}) {
  return await store().set(key, String(value), { metadata });
}

export async function setBinary(key, buffer, metadata = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const blob = new Blob([bytes], { type: metadata.contentType || 'application/octet-stream' });
  return await store().set(key, blob, { metadata });
}

export async function getText(key) {
  return await store().get(key, { type: 'text', consistency: 'strong' });
}

export async function getBinary(key) {
  return await store().get(key, { type: 'arrayBuffer', consistency: 'strong' });
}
