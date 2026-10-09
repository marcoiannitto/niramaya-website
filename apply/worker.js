/**
 * AEVUM Apply — Cloudflare Worker
 * GET  → returns seats remaining for the open cohort
 * POST → writes applicant to Airtable CRM, linked to open cohort
 *
 * Environment variables (CF dashboard → Workers → Settings → Variables):
 *   AIRTABLE_TOKEN  — Personal access token (scopes: data.records:read, data.records:write)
 *
 * Deploy:  npx wrangler deploy aevum-apply-worker.js --name aevum-apply
 */

const AIRTABLE_BASE    = 'app7n9Tx32hBTqasF';
const CRM_TABLE        = 'tblAjqQKlMXRR09i4';
const COHORTS_TABLE    = 'tblsMdjfOCseVnh2A';

const ALLOWED_ORIGINS = [
  'https://niramaya.sg',
  'https://www.niramaya.sg',
];

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(request, new Response(null, { status: 204 }));
    }

    if (request.method === 'GET') {
      return corsResponse(request, await handleGet(env));
    }

    if (request.method === 'POST') {
      return corsResponse(request, await handlePost(request, env));
    }

    return corsResponse(request, json({ error: 'Method not allowed' }, 405));
  }
};

// ── GET: seats remaining ──

async function handleGet(env) {
  try {
    // 1. Find the open cohort
    const cohort = await getOpenCohort(env);
    if (!cohort) {
      return json({ cohort: null, seats: 0, total: 0 });
    }

    const remaining = Math.max(0, cohort.totalSeats - cohort.applied);

    return json({
      cohort: cohort.name,
      seats: remaining,
      total: cohort.totalSeats
    });

  } catch (err) {
    console.error('GET error:', err);
    return json({ error: 'Failed to fetch seats' }, 500);
  }
}

// ── POST: create applicant ──

async function handlePost(request, env) {
  try {
    const body = await request.json();
    const { name, email, phone, readiness, motivation } = body;

    if (!name || !email || !phone || !readiness) {
      return json({ error: 'Missing required fields' }, 400);
    }

    // Split name
    const parts = name.trim().split(/\s+/);
    const firstName = parts[0] || '';
    const lastName = parts.length > 1 ? parts.slice(1).join(' ') : '';

    // Today (Singapore time)
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

    // Find open cohort to link
    const cohort = await getOpenCohort(env);

    const fields = {
      'Name':       firstName,
      'Last Name':  lastName,
      'Email':      email,
      'Phone':      phone,
      'Readiness':  readiness,
      'Motivation': motivation || '',
      'Channel':    'Web Form',
      'Stage':      'New Lead',
      'Last Touch': today,
      'Needs You':  true,
    };

    // Link to cohort if one is open
    if (cohort) {
      fields['Cohort'] = [cohort.id];
    }

    const res = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${CRM_TABLE}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ records: [{ fields }] })
      }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error('Airtable error:', err);
      return json({ error: 'Failed to save application' }, 502);
    }

    return json({ ok: true });

  } catch (err) {
    console.error('POST error:', err);
    return json({ error: 'Internal error' }, 500);
  }
}

// ── Helpers ──

async function getOpenCohort(env) {
  const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${COHORTS_TABLE}`);
  url.searchParams.set('filterByFormula', '{Status} = "Open"');
  url.searchParams.set('maxRecords', '1');

  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${env.AIRTABLE_TOKEN}` },
  });

  if (!res.ok) return null;

  const data = await res.json();
  if (!data.records || data.records.length === 0) return null;

  const rec = data.records[0];
  const linkedCRM = rec.fields['CRM'] || [];
  return {
    id: rec.id,
    name: rec.fields['Cohort'] || '',
    totalSeats: rec.fields['Total Seats'] || 0,
    applied: Array.isArray(linkedCRM) ? linkedCRM.length : 0,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function corsResponse(request, response) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', allowed);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, { status: response.status, headers });
}
