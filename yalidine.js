// services/yalidine.js
//
// Wrapper around the Yalidine API.
// Handles: wilayas, communes, centers (stop desks), and delivery fee lookups.
// Includes a simple in-memory cache because Yalidine's reference data
// (wilayas, communes, centers) barely ever changes, and we don't want to
// hammer their API on every single popup load.

// Uses Node's native global fetch (available Node 18+) — no dependency needed.

const BASE_URL = process.env.YALIDINE_BASE_URL || 'https://api.yalidine.app/v1';
const API_ID = process.env.YALIDINE_API_ID;
const API_TOKEN = process.env.YALIDINE_API_TOKEN;

// ---- Simple in-memory cache ----
// key -> { data, expiresAt }
const cache = new Map();

const CACHE_TTL = {
  wilayas: 24 * 60 * 60 * 1000,      // 24h - basically static
  communes: 24 * 60 * 60 * 1000,     // 24h - basically static
  centers: 12 * 60 * 60 * 1000,      // 12h - desks can occasionally change
  fees: 6 * 60 * 60 * 1000,          // 6h - prices can change more often
};

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key, data, ttl) {
  cache.set(key, { data, expiresAt: Date.now() + ttl });
}

function authHeaders() {
  if (!API_ID || !API_TOKEN || API_ID === 'my_api_id') {
    throw new Error(
      'Yalidine API credentials are not configured. Set YALIDINE_API_ID and YALIDINE_API_TOKEN in your .env file.'
    );
  }
  return {
    'X-API-ID': API_ID,
    'X-API-TOKEN': API_TOKEN,
    'Content-Type': 'application/json',
  };
}

async function yalidineGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: authHeaders(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Yalidine API error (${res.status}) on ${path}: ${text}`);
  }

  return res.json();
}

/**
 * Fetch all 58 wilayas.
 * Returns: [{ id, name, zone, is_deliverable }]
 */
async function getWilayas() {
  const cacheKey = 'wilayas';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await yalidineGet('/wilayas?fields=id,name,zone,is_deliverable');
  const wilayas = (data.data || []).sort((a, b) => a.id - b.id);

  setCached(cacheKey, wilayas, CACHE_TTL.wilayas);
  return wilayas;
}

/**
 * Fetch communes for a given wilaya ID.
 * Returns: [{ id, name, wilaya_id, has_stop_desk, is_deliverable }]
 */
async function getCommunes(wilayaId) {
  const cacheKey = `communes_${wilayaId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await yalidineGet(
    `/communes?wilaya_id=${encodeURIComponent(wilayaId)}&fields=id,name,wilaya_id,has_stop_desk,is_deliverable`
  );
  const communes = (data.data || []).sort((a, b) => a.name.localeCompare(b.name));

  setCached(cacheKey, communes, CACHE_TTL.communes);
  return communes;
}

/**
 * Fetch Yalidine stop desks (centers) for a given commune.
 * Returns: [{ center_id, name, address, commune_id, wilaya_id }]
 */
async function getCenters(communeId) {
  const cacheKey = `centers_${communeId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await yalidineGet(
    `/centers?commune_id=${encodeURIComponent(communeId)}&fields=center_id,name,address,commune_id,wilaya_id`
  );
  const centers = data.data || [];

  setCached(cacheKey, centers, CACHE_TTL.centers);
  return centers;
}

/**
 * Fetch delivery fees from a given "from" wilaya to a given "to" wilaya.
 * Yalidine's /fees endpoint returns desk + home delivery pricing per commune.
 * Returns the raw fees object: { from_wilaya_name, to_wilaya_name, zone, retour_fee,
 *   cod_percentage, insurance_percentage, oversize_fee, per_commune: { [communeName]: { commune_id, express_home, express_desk, ... } } }
 */
async function getFees(fromWilayaId, toWilayaId) {
  const cacheKey = `fees_${fromWilayaId}_${toWilayaId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await yalidineGet(
    `/fees?from_wilaya_id=${encodeURIComponent(fromWilayaId)}&to_wilaya_id=${encodeURIComponent(toWilayaId)}`
  );

  setCached(cacheKey, data, CACHE_TTL.fees);
  return data;
}

/**
 * Convenience helper: get desk + home delivery price for one specific commune,
 * given the wilaya you ship FROM (your store's wilaya) and the destination wilaya.
 *
 * IMPORTANT: Yalidine's /fees response keys `per_commune` by the commune's
 * numeric ID (as a string), e.g. per_commune["625"] for Akbou — NOT by name.
 */
async function getDeliveryPricing({ fromWilayaId, toWilayaId, communeId }) {
  const fees = await getFees(fromWilayaId, toWilayaId);

  // Defensive: some routes/wilaya combinations cause Yalidine's /fees
  // endpoint to return something other than the expected object shape
  // (e.g. an empty array). Treat anything without a usable per_commune
  // map as "no pricing available" instead of throwing or silently
  // returning stale/wrong data.
  if (!fees || typeof fees !== 'object' || Array.isArray(fees) || !fees.per_commune) {
    return {
      homeDelivery: null,
      deskDelivery: null,
      source: 'unavailable',
    };
  }

  const communeFees = fees.per_commune[String(communeId)];

  if (!communeFees) {
    // No pricing found for this specific commune (rare — usually means the
    // commune isn't served, or the ID didn't match).
    return {
      homeDelivery: null,
      deskDelivery: null,
      source: 'not_found',
    };
  }

  return {
    homeDelivery: communeFees.express_home ?? null,
    deskDelivery: communeFees.express_desk ?? null,
    source: 'commune',
  };
}

module.exports = {
  getWilayas,
  getCommunes,
  getCenters,
  getFees,
  getDeliveryPricing,
};
