'use strict';
// Writes the 7 synthetic demo resumes into profiles-seed\demo\resumes\ (deterministic: rerun gives identical bytes).
// Fictional candidate, employers and school; public certification names only. The skills line is split across
// several runs (bold label + text split mid-word) so the builtin generator's split-run edits are exercised.
// Usage (from jd-fit-checker): node scripts\build-demo.cjs [--out <dir>]
// Lineage: PM_BASE_General -> PM_Fintech_Payments -> PM_Acme_Payments (submitted) -> PM_Acme_Payments_v2 (variant);
//          Ops_BASE_Analytics -> Ops_Globex_Supply (submitted); PM_Initech_Growth (generated-pending, from PM_BASE_General).

const fs = require('fs');
const path = require('path');
const { buildDocx } = require('../lib/docx-write.cjs');

const PREFIX = 'Demo_';
const OUT_DEFAULT = path.join(__dirname, '..', 'profiles-seed', 'demo', 'resumes');

const H = (text) => ({ style: 'Heading1', runs: [{ text }] });
const P = (text) => ({ runs: [{ text }] });
const B = (label, text) => ({ runs: [{ text: label, bold: true }, { text }] });

// Skills line: label run + text split mid-word across runs ("A/B te" + "sting", "Conf" + "luence").
function skills(tools) {
  const t = tools || 'Trello, Confluence';
  const cut = Math.max(1, t.length - 6);
  return { runs: [{ text: 'Skills: ', bold: true }, { text: 'SQL, Excel, Python, A/B te' }, { text: `sting, Roadmapping | Tools: ${t.slice(0, cut)}` }, { text: t.slice(cut) }] };
}

const HEADER = [
  { style: 'Title', runs: [{ text: 'Casey Sample' }] },
  P('Associate Product Manager | Bengaluru | casey.sample@example.com | Demo profile (fictional)')
];
const EDUCATION = [
  H('Education'),
  P('MBA, Northgate School of Management (2020 - 2022)'),
  P('B.Sc. Statistics, Riverton State University (2016 - 2019)')
];
const CERTS = B('Certifications: ', 'Google Analytics certification; Tableau Desktop Specialist');

function pmResume({ summary, closing, extraBullet, tools }) {
  return [
    ...HEADER,
    H('Summary'),
    P(`${summary} ${closing}`),
    H('Experience'),
    B('Associate Product Manager, Brightwater Commerce ', '(2022 - Present)'),
    P('- Owned the checkout roadmap and wrote PRDs with acceptance criteria for 3 squads.'),
    P('- Ran 12 A/B tests on checkout and shipped guest checkout, lifting conversion 6%.'),
    P('- Ran product discovery with 40 customer interviews and prioritized the backlog in Jira.'),
    ...(extraBullet ? [P(extraBullet)] : []),
    P('- Built SQL dashboards in Tableau used in weekly business reviews.'),
    B('Business Analyst, Lakeview Logistics ', '(2020 - 2022)'),
    P('- Automated shipment reports in Python and Excel, saving 10 hrs per week.'),
    P('- Analysed supply chain data for 5 warehouses with stakeholders in operations.'),
    ...EDUCATION,
    H('Skills'),
    skills(tools),
    CERTS
  ];
}

function opsResume({ closing, extraBullet }) {
  return [
    ...HEADER.slice(0, 1),
    P('Operations and Analytics | Bengaluru | casey.sample@example.com | Demo profile (fictional)'),
    H('Summary'),
    P(`Analyst with 4 years in supply chain reporting, warehouse data and checkout analytics. ${closing}`),
    H('Experience'),
    B('Associate Product Manager, Brightwater Commerce ', '(2022 - Present)'),
    P('- Built SQL dashboards in Tableau used in weekly business reviews.'),
    P('- Ran 12 A/B tests on checkout and shipped guest checkout, lifting conversion 6%.'),
    B('Business Analyst, Lakeview Logistics ', '(2020 - 2022)'),
    P('- Automated shipment reports in Python and Excel, saving 10 hrs per week.'),
    P('- Analysed supply chain data for 5 warehouses with stakeholders in operations.'),
    P('- Cut late dispatches 9% by flagging delayed orders in a daily Excel model.'),
    ...(extraBullet ? [P(extraBullet)] : []),
    ...EDUCATION,
    H('Skills'),
    skills('Excel, Looker Studio'),
    CERTS
  ];
}

const GENERAL_SUMMARY = 'Product manager with 4 years across e-commerce checkout and analytics: discovery, roadmaps, PRDs and experiments.';
const PAYMENTS_SUMMARY = 'Product manager with 4 years across payments, checkout and analytics: discovery, roadmaps, PRDs and experiments.';
const PAYMENTS_BULLET = '- Launched UPI payment retries with the gateway team, cutting failed payments 8%.';

const RESUMES = {
  PM_BASE_General: pmResume({ summary: GENERAL_SUMMARY, closing: 'Seeking a Product Manager role building consumer products.' }),
  PM_Fintech_Payments: pmResume({ summary: PAYMENTS_SUMMARY, closing: 'Seeking a Product Manager role in payments.', extraBullet: PAYMENTS_BULLET }),
  PM_Acme_Payments: pmResume({ summary: PAYMENTS_SUMMARY, closing: 'Seeking a Product Manager role at Acme Payments.', extraBullet: PAYMENTS_BULLET }),
  PM_Acme_Payments_v2: pmResume({ summary: PAYMENTS_SUMMARY, closing: 'Seeking a Product Manager role at Acme Payments.', extraBullet: PAYMENTS_BULLET, tools: 'Mixpanel funnels | Confluence' }),
  PM_Initech_Growth: pmResume({ summary: GENERAL_SUMMARY, closing: 'Seeking a Product Manager role in growth at Initech.' }),
  Ops_BASE_Analytics: opsResume({ closing: 'Seeking an analytics role in supply chain operations.' }),
  Ops_Globex_Supply: opsResume({ closing: 'Seeking an analytics role in supply chain at Globex.', extraBullet: '- Mapped inbound flows for 2 regional hubs.' })
};

function build(outDir = OUT_DEFAULT) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [name, paragraphs] of Object.entries(RESUMES)) {
    const file = path.join(outDir, `${PREFIX}${name}.docx`);
    fs.writeFileSync(file, buildDocx(paragraphs));
    written.push(file);
  }
  return written;
}

if (require.main === module) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : OUT_DEFAULT;
  const crypto = require('crypto');
  for (const f of build(out)) console.log(`${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}  ${path.basename(f)}`);
}

module.exports = { build, RESUMES, PREFIX, OUT_DEFAULT };
