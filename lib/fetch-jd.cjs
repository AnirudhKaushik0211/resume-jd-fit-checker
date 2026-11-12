'use strict';

// Job-posting URL fetch: URL validation + SSRF guard, a single https GET (the only outbound request this tool
// makes; nothing from resumes/config is sent), JSON-LD JobPosting extraction, HTML -> text, login-wall detection.

const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');
const { decodeEntities } = require('./text.cjs');

const TIMEOUT_MS = 15000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MIN_TEXT = 400;
const PASTE_MSG = 'This site needs a login or blocks automated reads. Paste the JD text instead.';

function fail(code, message) { return { ok: false, code, message }; }

function ipv4ToInt(ip) { return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0; }
function inCidr(ip, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}
const V4_BLOCKS = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]];

function isPrivateAddress(ip) {
  const addr = String(ip || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(addr)) return V4_BLOCKS.some(([b, n]) => inCidr(addr, b, n));
  if (net.isIPv6(addr)) {
    if (addr === '::' || addr === '::1') return true;
    const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(addr)) return true; // hex-form mapped v4: reject conservatively
    if (/^f[cd]/.test(addr)) return true; // fc00::/7
    if (/^fe[89ab]/.test(addr)) return true; // fe80::/10
    if (/^ff/.test(addr)) return true; // multicast
    return false;
  }
  return true; // not an IP literal -> treat as unsafe here
}

// Synchronous checks (no DNS). http is accepted and upgraded to https.
function validateUrlSyntax(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { return { ok: false, reason: 'Not a valid URL.' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: `Only http/https links are allowed (got ${u.protocol}).` };
  if (u.username || u.password) return { ok: false, reason: 'URLs with credentials are not allowed.' };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return { ok: false, reason: 'URL has no host.' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !net.isIP(host)) return { ok: false, reason: 'Local / intranet hosts are not allowed.' };
  if (net.isIP(host) && isPrivateAddress(host)) return { ok: false, reason: 'Private, loopback and link-local addresses are not allowed.' };
  if (u.port && !((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80'))) return { ok: false, reason: 'Non-standard ports are not allowed.' };
  const upgraded = new URL(u.href);
  upgraded.protocol = 'https:';
  upgraded.port = '';
  upgraded.hash = '';
  return { ok: true, url: upgraded.href, host, upgraded: u.protocol === 'http:' };
}

async function resolveAndCheck(input, lookup = dns.promises.lookup) {
  const v = validateUrlSyntax(input);
  if (!v.ok) return v;
  if (net.isIP(v.host)) return { ...v, address: v.host, family: net.isIP(v.host) };
  let addrs;
  try { addrs = await lookup(v.host, { all: true }); } catch (e) { return { ok: false, reason: `DNS lookup failed for ${v.host} (${e.code || e.message}).`, dns: true }; }
  if (!addrs.length) return { ok: false, reason: `No address for ${v.host}.`, dns: true };
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) return { ok: false, reason: `${v.host} resolves to a private address (${bad.address}).` };
  return { ...v, address: addrs[0].address, family: addrs[0].family };
}

function classifyResponse(status, finalUrl, text) {
  if ([401, 403, 429, 999].includes(status)) return fail('PASTE_INSTEAD', `${PASTE_MSG} (HTTP ${status})`);
  let u = null;
  try { u = new URL(finalUrl); } catch { /* ignore */ }
  if (u && /(^|\.)linkedin\.com$/i.test(u.hostname) && /\/(authwall|login|checkpoint|uas\/login|signup)/i.test(u.pathname)) return fail('PASTE_INSTEAD', `${PASTE_MSG} (LinkedIn login wall)`);
  // LinkedIn answers logged-out / automated reads with 4xx (404, 429, 999) even for live postings.
  if (u && /(^|\.)linkedin\.com$/i.test(u.hostname) && status >= 400) return fail('PASTE_INSTEAD', `${PASTE_MSG} (LinkedIn HTTP ${status})`);
  if (status >= 400) return fail('FETCH_FAILED', `The page returned HTTP ${status}.`);
  if (text !== undefined) {
    const t = String(text || '');
    if (t.length < MIN_TEXT) return fail('PASTE_INSTEAD', `${PASTE_MSG} (only ${t.length} characters of readable text)`);
    if (/\b(sign in to (view|see|apply|continue)|join now to|log in to continue|please log in|sign in to linkedin|join linkedin)\b/i.test(t) && t.length < 1500) return fail('PASTE_INSTEAD', `${PASTE_MSG} (login wall)`);
  }
  return null;
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|nav|header|footer|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<(br|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(p|div|li|ul|ol|h[1-6]|section|article|tr|table|blockquote)\s*>/gi, '\n');
  s = s.replace(/<(p|div|h[1-6]|section|article|tr|table|ul|ol)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(decodeEntities(s));
  return s.split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter((l, i, arr) => l || (arr[i - 1] && arr[i - 1].trim())).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function findJobPostings(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => findJobPostings(n, out)); return out; }
  const type = node['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) out.push(node);
  if (node['@graph']) findJobPostings(node['@graph'], out);
  return out;
}

function metaContent(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(re);
  return m ? decodeEntities(m[1] || m[2] || '').trim() : '';
}

function extractJobFromHtml(html, finalUrl) {
  const blocks = [...String(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let data;
    try { data = JSON.parse(b[1].trim()); } catch { continue; }
    const jp = findJobPostings(data)[0];
    if (!jp) continue;
    const org = jp.hiringOrganization;
    const loc = [].concat(jp.jobLocation || [])[0];
    // Many sites entity-encode the HTML inside description (&lt;p&gt;): decode once before stripping tags.
    const rawDesc = String(jp.description || '');
    const text = htmlToText(/&lt;\/?[a-z]/i.test(rawDesc) ? decodeEntities(rawDesc) : rawDesc);
    return {
      ok: true, source: 'jsonld', finalUrl,
      title: String(jp.title || '').trim(),
      company: String((org && (org.name || org)) || '').trim(),
      location: String((loc && loc.address && (loc.address.addressLocality || loc.address.addressRegion)) || '').trim(),
      text
    };
  }
  const title = metaContent(html, 'og:title') || decodeEntities(((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim());
  const company = metaContent(html, 'og:site_name');
  const bodyMatch = String(html).match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return { ok: true, source: 'html', finalUrl, title, company, location: '', text: htmlToText(bodyMatch ? bodyMatch[1] : html) };
}

function decompress(buf, enc) {
  const e = String(enc || '').toLowerCase();
  if (e.includes('gzip')) return zlib.gunzipSync(buf);
  if (e.includes('br')) return zlib.brotliDecompressSync(buf);
  if (e.includes('deflate')) { try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); } }
  return buf;
}

function getOnce(checked, deadline) {
  return new Promise((resolve) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return resolve({ error: fail('TIMEOUT', 'The page took longer than 15 seconds.') });
    const req = https.get(checked.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (JD-Fit-Checker local prototype)', Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en' },
      // Pin the connection to the address we validated (prevents DNS rebinding between check and connect).
      lookup: (host, opts, cb) => {
        if (opts && opts.all) cb(null, [{ address: checked.address, family: checked.family }]);
        else cb(null, checked.address, checked.family);
      },
      timeout: remaining
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(); resolve({ error: fail('TOO_LARGE', 'The page is larger than 2 MB.') }); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        let body;
        try { body = decompress(Buffer.concat(chunks), res.headers['content-encoding']).toString('utf8'); } catch (e) { return resolve({ error: fail('FETCH_FAILED', `Could not decode the page (${e.message}).`) }); }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
      res.on('error', (e) => resolve({ error: fail('FETCH_FAILED', e.message) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: fail('TIMEOUT', 'The page took longer than 15 seconds.') }); });
    req.on('error', (e) => resolve({ error: fail('FETCH_FAILED', `Network error: ${e.code || e.message}`) }));
  });
}

async function fetchJob(input, { lookup } = {}) {
  const deadline = Date.now() + TIMEOUT_MS;
  let current = input;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = await resolveAndCheck(current, lookup);
    if (!checked.ok) return fail(checked.dns ? 'FETCH_FAILED' : (hop ? 'BLOCKED_URL' : (validateUrlSyntax(current).ok ? 'BLOCKED_URL' : 'INVALID_URL')), checked.reason);
    const r = await getOnce(checked, deadline);
    if (r.error) return r.error;
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      const next = new URL(r.headers.location, checked.url).href;
      const early = classifyResponse(200, next);
      if (early) return early;
      current = next;
      continue;
    }
    const pre = classifyResponse(r.status, checked.url);
    if (pre) return pre;
    const job = extractJobFromHtml(r.body, checked.url);
    const post = classifyResponse(r.status, checked.url, job.text);
    if (post) return post;
    return job;
  }
  return fail('FETCH_FAILED', 'Too many redirects.');
}

module.exports = { validateUrlSyntax, isPrivateAddress, resolveAndCheck, classifyResponse, extractJobFromHtml, htmlToText, fetchJob, PASTE_MSG };
