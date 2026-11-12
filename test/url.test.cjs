'use strict';

// URL validation (SSRF guard) and HTML parsing. No network is used in unit tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateUrlSyntax, isPrivateAddress, resolveAndCheck, classifyResponse, extractJobFromHtml } = require('../lib/fetch-jd.cjs');

const html = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', 'html', f), 'utf8');

test('rejects non-http(s), localhost, private / link-local IPs, credentials and odd ports', () => {
  for (const u of ['file:///C:/x', 'ftp://example.com/x', 'http://localhost:4317', 'http://127.0.0.1', 'https://10.0.0.5/job', 'https://192.168.1.1', 'https://172.16.0.1', 'https://169.254.169.254/latest', 'http://[::1]/', 'https://user:pw@example.com', 'https://example.com:8080/x', 'https://intranet/x', 'javascript:alert(1)']) {
    assert.equal(validateUrlSyntax(u).ok, false, u);
  }
});

test('accepts public https and upgrades http', () => {
  const ok = validateUrlSyntax('https://boards.greenhouse.io/x/jobs/1');
  assert.equal(ok.ok, true);
  const up = validateUrlSyntax('http://jobs.lever.co/acme/123');
  assert.equal(up.ok, true);
  assert.ok(up.url.startsWith('https://'));
});

test('isPrivateAddress covers v4, v6 and mapped addresses', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '100.64.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1']) assert.ok(isPrivateAddress(a), a);
  for (const a of ['8.8.8.8', '104.16.0.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(a), a);
});

test('DNS results pointing to a private address are rejected (rebinding guard)', async () => {
  const fake = async () => [{ address: '10.0.0.7', family: 4 }];
  const r = await resolveAndCheck('https://evil.example.com/job', fake);
  assert.equal(r.ok, false);
  const good = await resolveAndCheck('https://good.example.com/job', async () => [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(good.ok, true);
  assert.equal(good.address, '93.184.216.34');
});

test('JSON-LD JobPosting in @graph is preferred (invalid blocks skipped)', () => {
  const r = extractJobFromHtml(html('jsonld-graph.html'), 'https://acme.example/jobs/1');
  assert.equal(r.source, 'jsonld');
  assert.equal(r.title, 'Associate Product Manager');
  assert.equal(r.company, 'Acme Labs');
  assert.equal(r.location, 'Bengaluru');
  assert.match(r.text, /discovery & roadmap/);
  assert.match(r.text, /- Write PRDs/);
});

test('no JSON-LD -> stripped page text without script/style/nav/footer', () => {
  const r = extractJobFromHtml(html('plain.html'), 'https://example.co/jobs/1');
  assert.equal(r.source, 'html');
  assert.equal(r.title, 'Product Manager, Payments');
  assert.ok(!/tracking|Site header|Footer links|color:red/.test(r.text));
  assert.match(r.text, /3\+ years of product management/);
  assert.equal(classifyResponse(200, 'https://example.co/jobs/1', r.text), null);
});

test('LinkedIn-style login wall, short text and 999/403 -> PASTE_INSTEAD', () => {
  const li = extractJobFromHtml(html('linkedin-authwall.html'), 'https://www.linkedin.com/jobs/view/1');
  assert.equal(classifyResponse(200, 'https://www.linkedin.com/jobs/view/1', li.text).code, 'PASTE_INSTEAD');
  assert.equal(classifyResponse(200, 'https://x.example/jobs/1', 'too short').code, 'PASTE_INSTEAD');
  assert.equal(classifyResponse(999, 'https://www.linkedin.com/jobs/view/1').code, 'PASTE_INSTEAD');
  assert.equal(classifyResponse(403, 'https://x.example/').code, 'PASTE_INSTEAD');
  assert.equal(classifyResponse(200, 'https://www.linkedin.com/authwall?trk=1').code, 'PASTE_INSTEAD');
  assert.equal(classifyResponse(404, 'https://www.linkedin.com/jobs/view/1').code, 'PASTE_INSTEAD');
  assert.equal(classifyResponse(404, 'https://x.example/jobs/1').code, 'FETCH_FAILED');
});
