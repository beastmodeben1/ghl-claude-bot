// cron-follow-up.js — ADAPTIVE FOLLOW-UP ENGINE (Streamlined-native rebuild)
// ---------------------------------------------------------------------------
// Finds leads who went quiet (last message was ours, older than the cadence gap),
// picks a cadence based on stage + objection tags + whether they ever engaged
// (by text OR phone), drafts a human follow-up with Claude using
// knowledge-base-follow-up.txt, and sends it via GHL.
//
// SAFE BY DEFAULT: starts in DRY RUN (sends nothing, just prints/report what it WOULD
// send). Flip CONFIG.DRY_RUN to false only when you're happy with the plan.
//
// Runs as a Render Cron Job. Everything you'll want to tweak is in CONFIG below.
// ===========================================================================

const axios = require('axios');
const fs = require('fs');

// ===========================================================================
//  CONFIG  —  EDIT THIS BLOCK.  You shouldn't need to touch anything below it.
// ===========================================================================
const CONFIG = {

  // ---- SAFETY ----
  DRY_RUN: true,              // true = send nothing, just log the plan. Set false to go live.
  DAILY_SEND_CAP: 100,        // hard limit on messages sent in one run
  MIN_GHOST_DAYS: 2,          // ignore anyone we texted more recently than this
  RECENT_CALL_DAYS: 3,        // skip anyone we've CALLED in the last N days (don't step on a live convo / appointment)

  // ---- TEST SCOPE ----
  // Leave EMPTY [] to run against everyone eligible.
  // Put one or more tags here to ONLY process contacts carrying at least one of them.
  // Great for testing: tag ~10 leads with something like 'ai followup test' and set it here.
  ONLY_TAGS: ['pfc ai'],   // only work contacts the team has switched on for the AI

  // When true AND ONLY_TAGS is set, ALSO pull in any contact carrying a test tag even if they
  // don't meet the normal stage/ghost rules (so you can text your own number). Still 100% locked
  // to ONLY_TAGS and still respects NEVER_TAGS, business hours, and the daily cap.
  TEST_MODE: false,

  // ---- WHO WE ARE ----
  ACCOUNT_ID: 'OuIxba3Lr0bnZvndMh3Z',   // Caruth Brothers Real Estate (Streamlined account_id)
  BOT_NAME: 'Peter',
  COMPANY_NAME: 'Caruth Brothers',
  TIMEZONE: 'America/Chicago',

  // ---- WHEN IT'S ALLOWED TO SEND (local time) ----
  BUSINESS_HOURS: { start: 9, end: 20 },   // 9am–8pm. Cron should be scheduled inside this window.

  // ---- WHO TO PRIORITIZE when we hit the cap ----
  // 'engaged_first'  = people who engaged (text or phone) then ghosted go first, then cold leads
  // 'oldest_first'   = whoever we've ignored longest
  // 'newest_first'   = freshest ghosts first
  PRIORITIZE: 'engaged_first',

  // ---- PIPELINE STAGES WE FOLLOW UP IN ----
  TARGET_STAGES: [
    'PFC Weekly Follow Up',
    'PFC Monthly Follow Up',
    'PFC Monthly - Needs Nurtured',
    'New Lead - Needs Nurtured',
    'Deep Dive',
    'Opt In',
    'FB PFC Weekly Follow Up',
    'FB PFC Monthly Follow Up',
    'FB Needs Nurtured',
    'FB PFC Attempted Contact',
    'RedZone PFC',
    'No Answer',
    'SMS Sent',
    'Active Auction - Check #',
    'FB Loan Mod',
    'FB Bankruptcy',
    'FB Offer Made',
    'FB Offer Denied'
  ],

  // ---- NEVER follow up if the contact has an OPEN opportunity in one of these stages ----
  // (matched case-insensitively, across ALL pipelines)
  NEVER_STAGES: [
    'Under Contract', 'UC - On Hold', 'Closed', 'Deal Closed', 'Passed', 'No Deal / Passed'
  ],

  // ---- NEVER follow up if the contact carries ANY of these tags ----
  NEVER_TAGS: [
    'do not contact', 'do_not_contact', 'dnd enabled', 'dnd',
    'stop bot', 'stop_bot', 'manual takeover', 'manual_takeover',
    'remove automation',
    'wrong number', 'spam troll',
    'pfc working with an attorney'   // legal involved — leave alone
  ],

  // ---- "HANDLED / RESOLVED" DETECTION ----
  // If their LAST inbound text contains any of these, we assume they told us it's handled/resolved.
  // We DON'T stop (only a real opt-out / do-not-contact tag stops them). A lot of these folks
  // fall back into foreclosure, so we keep a SOFT check-in: first touch ~6.5 weeks out, then
  // every ~38 days until they say stop. Tune via HANDLED_PHRASES and the 'handled' cadence.
  HANDLED_PHRASES: [
    'taken care of', 'handled', 'caught up', 'all set', 'we are good', "we're good",
    'im good', "i'm good", 'got it covered', 'current on', 'reinstat', 'refinanc',
    'paid off', 'all good', 'good now', 'already sold', 'we sold', 'it sold',
    'loss mitigation', 'loss mit', 'off of foreclosure', 'off foreclosure',
    'out of foreclosure', 'not in foreclosure', 'no longer in foreclosure',
    'pay the arrears', 'paid the arrears', 'the arrears', 'arrears',
    'modification approved', 'loan mod approved', 'mod approved', 'approved for'
  ],

  // ---- CADENCES ----
  // Each cadence is a list of GAPS (days to wait between touches), read left to right.
  // gaps[0] = days after they ghosted before touch #1, gaps[1] = wait before touch #2, etc.
  // After the list runs out, the LAST gap repeats. max_touches caps total nudges.
  CADENCES: {
    engaged:       { gaps: [2, 3, 3, 4, 6, 8, 14, 21, 30], max_touches: 12, offend_on_touch: 3 },
    loan_mod:      { gaps: [3, 4, 7, 7, 14, 21, 30],        max_touches: 10 },
    lender:        { gaps: [3, 5, 7, 14, 21, 30],           max_touches: 10 },
    bankruptcy:    { gaps: [10, 21, 30, 45, 60],            max_touches: 8  },
    under_contract:{ gaps: [14, 21, 30, 45, 60],            max_touches: 6  },
    seller:        { gaps: [3, 5, 7, 14, 21, 30],           max_touches: 10 },
    weekly:        { gaps: [7],                             max_touches: 12 },
    monthly:       { gaps: [30],                            max_touches: 12 },
    handled:       { gaps: [45, 38],                        max_touches: 24 }, // ~6.5 wks, then every ~38 days until they say stop
    cold:          { gaps: [3, 5, 10, 21, 40, 60],          max_touches: 7  },
    offer:         { gaps: [3, 5, 7, 14, 21, 30],           max_touches: 8  }, // 3 days after offer, then space out
    fb_drip:       { gaps: [14],                            max_touches: 100 }, // FB lead who never answered: steady every ~14 days until they say stop
    default:       { gaps: [3, 7, 14, 30, 45],              max_touches: 8  }
  },

  // ---- OBJECTION TAG -> CADENCE (overrides stage; 'handled' text signal wins over these) ----
  OBJECTION_TAG_TO_CADENCE: {
    'pfc loan mod': 'loan_mod',
    'pfc working with mortgage company': 'lender',
    'pfc bankruptcy': 'bankruptcy',
    'fb bankruptcy': 'bankruptcy',
    'pfc house is under contract': 'under_contract',
    'pfc wants to sell': 'seller',
    'pfc selling on market': 'seller'
  },

  // ---- PIPELINE STAGE -> CADENCE (used when no objection tag / handled / engaged applies) ----
  STAGE_TO_CADENCE: {
    'PFC Weekly Follow Up': 'weekly',
    'FB PFC Weekly Follow Up': 'weekly',
    'PFC Monthly Follow Up': 'monthly',
    'FB PFC Monthly Follow Up': 'monthly',
    'PFC Monthly - Needs Nurtured': 'monthly',
    'Deep Dive': 'engaged',
    'Opt In': 'engaged',
    'New Lead - Needs Nurtured': 'engaged',
    'FB Needs Nurtured': 'engaged',
    'FB PFC Attempted Contact': 'cold',
    'RedZone PFC': 'engaged',
    'No Answer': 'cold',
    'SMS Sent': 'cold',
    'Active Auction - Check #': 'cold',
    'FB Loan Mod': 'loan_mod',
    'FB Bankruptcy': 'bankruptcy',
    'FB Offer Made': 'offer',
    'FB Offer Denied': 'offer'
  },

  // If a lead ENGAGED at least once (replied by text OR had a real phone call) before going
  // quiet, treat them as 'engaged' regardless of stage (unless handled/objection applies).
  ENGAGED_OVERRIDE_IF_ENGAGED: true,

  // A call counts as "real engagement" if completed and at least this many seconds,
  // OR if it produced an AI call summary (summaries only exist for real conversations).
  MIN_CALL_SECONDS: 60,

  // How many recent messages / notes / call summaries to give Claude for context
  CONTEXT_MESSAGE_LIMIT: 12,
  CONTEXT_NOTE_LIMIT: 3,
  CONTEXT_CALL_LIMIT: 2,

  // Candidate pool size pulled from the DB per run (before cap + timing filters)
  CANDIDATE_LIMIT: 500,

  // Seconds to pause between live sends (be gentle with the carrier)
  SEND_DELAY_SECONDS: 3,

  // ---- GHOST EMAIL (for FB drip leads) ----
  // On fb_drip touches, also send a CONVERSATIONAL, situational email. The subject and body
  // are written fresh by the AI each time (so subjects vary and the body references the
  // person's situation). A booking link is appended under the body automatically.
  // NOTE: requires the GHL location's sending email/domain to be set up. Test the first one.
  // Set to false to turn emails off entirely.
  SEND_GHOST_EMAIL: true,
  OPTIONS_LINK: 'https://options.caruthbrothers.com',

  FOLLOWUP_KB_FILE: './knowledge-base-follow-up.txt',
  CLAUDE_MODEL: 'claude-sonnet-4-6'
};
// ===========================================================================
//  END CONFIG
// ===========================================================================

const GHL_API_KEY = process.env.GHL_API_KEY || process.env.CARUTH_GHL_API_KEY;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const STREAMLINED_API_KEY = process.env.STREAMLINED_API_KEY;

// Load the follow-up knowledge base
let FOLLOWUP_KB = '';
try {
  FOLLOWUP_KB = fs.readFileSync(CONFIG.FOLLOWUP_KB_FILE, 'utf8')
    .replace(/{{COMPANY_NAME}}/g, CONFIG.COMPANY_NAME)
    .replace(/{{BOT_NAME}}/g, CONFIG.BOT_NAME);
  console.log(`✅ Loaded follow-up KB (${FOLLOWUP_KB.length} chars)`);
} catch (e) {
  console.log('⚠️ Could not load follow-up KB, using minimal fallback');
  FOLLOWUP_KB = 'You are a pre-foreclosure specialist re-engaging a lead who went quiet. One short human message.';
}

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

function pgArray(arr) {
  const items = arr.map(s => `'${String(s).replace(/'/g, "''")}'`).join(',');
  return `ARRAY[${items}]`;
}

function nowHourInTz(tz) {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }));
}

function isBusinessHours() {
  const h = nowHourInTz(CONFIG.TIMEZONE);
  return h >= CONFIG.BUSINESS_HOURS.start && h < CONFIG.BUSINESS_HOURS.end;
}

function makeMessageHuman(message) {
  if (!message) return message;
  let c = message;
  c = c.replace(/(\w+)\s*-\s+(\w+)/g, '$1 $2');
  c = c.replace(/;/g, ',');
  c = c.replace(/—/g, ' ').replace(/–/g, ' ');
  c = c.replace(/\.{3,}/g, '');
  c = c.replace(/\s{2,}/g, ' ');
  return c.trim();
}

function isHandled(lastInboundBody) {
  if (!lastInboundBody) return false;
  const b = String(lastInboundBody).toLowerCase();
  return CONFIG.HANDLED_PHRASES.some(p => b.includes(p));
}

// Run a read-only SQL query against Streamlined
async function sql(query) {
  const response = await axios.post(
    'https://gateway.streamlined.so/query/api/execute-sql',
    { sql: query },
    { headers: { 'Content-Type': 'application/json', 'X-API-Key': STREAMLINED_API_KEY } }
  );
  if (response.data.status === 'error') {
    throw new Error(`Streamlined error: ${JSON.stringify(response.data.error)}`);
  }
  return response.data.result || [];
}

// --------------------------------------------------------------------------
// Step 1: find ghosted candidates (with phone-engagement flag + last inbound text)
// --------------------------------------------------------------------------
async function getCandidates() {
  const A = `'${CONFIG.ACCOUNT_ID}'`;
  const query = `
    WITH targets AS (
      SELECT o.contact_id, ps.name AS stage
      FROM opportunities o
      JOIN pipeline_stages ps ON ps.id = o.pipeline_stage_id
      WHERE o.account_id = ${A} AND o.status = 'open'
        AND ps.name = ANY(${pgArray(CONFIG.TARGET_STAGES)})
    ),
    ms AS (
      SELECT m.contact_id,
        MAX(m.timestamp) FILTER (WHERE m.direction='inbound')  AS last_inbound,
        MAX(m.timestamp) FILTER (WHERE m.direction='outbound') AS last_outbound
      FROM messages m
      JOIN targets t ON t.contact_id = m.contact_id
      WHERE m.account_id = ${A} AND m.type='sms'
      GROUP BY m.contact_id
    ),
    ghosted AS (
      SELECT t.contact_id, t.stage, ms.last_inbound, ms.last_outbound
      FROM targets t
      JOIN ms ON ms.contact_id = t.contact_id
      WHERE ms.last_outbound IS NOT NULL
        AND (ms.last_inbound IS NULL OR ms.last_outbound > ms.last_inbound)
        AND ms.last_outbound < NOW() - INTERVAL '${CONFIG.MIN_GHOST_DAYS} days'
      ORDER BY ms.last_outbound DESC
      LIMIT ${CONFIG.CANDIDATE_LIMIT}
    ),
    called AS (
      SELECT DISTINCT k.contact_id
      FROM calls k
      WHERE k.account_id = ${A}
        AND (
          (k.status='completed' AND COALESCE(k.duration,0) >= ${CONFIG.MIN_CALL_SECONDS})
          OR EXISTS (SELECT 1 FROM call_analysis_results car WHERE car.call_id = k.id AND car.step_slug='call_summary')
        )
    )
    SELECT g.contact_id, g.stage, c.name, c.phone, c.email, c.tags,
           g.last_inbound, g.last_outbound,
           EXTRACT(EPOCH FROM (NOW() - g.last_outbound))/86400 AS days_since_out,
           (g.last_inbound IS NOT NULL) AS has_replied,
           (cl.contact_id IS NOT NULL) AS has_call,
           (SELECT string_agg(x.body, ' || ') FROM (
              SELECT body FROM messages mi
              WHERE mi.contact_id = g.contact_id AND mi.type='sms' AND mi.direction='inbound'
              ORDER BY mi.timestamp DESC LIMIT 3) x) AS last_inbound_body,
           (SELECT COUNT(*) FROM messages m2
              WHERE m2.contact_id = g.contact_id AND m2.type='sms' AND m2.direction='outbound'
                AND (g.last_inbound IS NULL OR m2.timestamp > g.last_inbound)
           ) AS unanswered
    FROM ghosted g
    JOIN contacts c ON c.id = g.contact_id
    LEFT JOIN called cl ON cl.contact_id = g.contact_id
    WHERE NOT EXISTS (
      SELECT 1 FROM tasks tk
      WHERE tk.contact_id = g.contact_id AND tk.is_completed = false AND tk.due_date > NOW()
    )
    AND NOT EXISTS (
      SELECT 1 FROM calls kk
      WHERE kk.contact_id = g.contact_id AND kk.account_id = ${A}
        AND kk.created_at > NOW() - INTERVAL '${CONFIG.RECENT_CALL_DAYS} days'
    )
    AND NOT EXISTS (
      SELECT 1 FROM opportunities ox
      JOIN pipeline_stages px ON px.id = ox.pipeline_stage_id
      WHERE ox.contact_id = g.contact_id AND ox.account_id = ${A} AND ox.status = 'open'
        AND lower(px.name) = ANY(${pgArray(CONFIG.NEVER_STAGES.map(x => x.toLowerCase()))})
    )
  `;
  return sql(query);
}

// Pull recent messages + notes + call summaries so Claude has full context
async function getContext(contactId) {
  const A = `'${CONFIG.ACCOUNT_ID}'`;
  const id = `'${String(contactId).replace(/'/g, "''")}'`;
  const [msgs, notes, calls] = await Promise.all([
    sql(`SELECT direction, body, timestamp FROM messages
         WHERE account_id=${A} AND contact_id=${id} AND type='sms' AND body IS NOT NULL
         ORDER BY timestamp DESC LIMIT ${CONFIG.CONTEXT_MESSAGE_LIMIT}`),
    sql(`SELECT body, created_at FROM notes
         WHERE account_id=${A} AND contact_id=${id}
         ORDER BY created_at DESC LIMIT ${CONFIG.CONTEXT_NOTE_LIMIT}`),
    sql(`SELECT to_char(k.created_at,'YYYY-MM-DD') AS d, k.status, k.duration,
                (car.result->>'value') AS summary
         FROM calls k
         LEFT JOIN call_analysis_results car ON car.call_id=k.id AND car.step_slug='call_summary'
         WHERE k.account_id=${A} AND k.contact_id=${id}
           AND (car.result IS NOT NULL OR (k.status='completed' AND COALESCE(k.duration,0) >= ${CONFIG.MIN_CALL_SECONDS}))
         ORDER BY k.created_at DESC LIMIT ${CONFIG.CONTEXT_CALL_LIMIT}`)
  ]);
  return { msgs: msgs.reverse(), notes, calls };
}

// TEST MODE: pull any contact carrying an ONLY_TAGS tag, regardless of stage/ghost rules.
// Used so you can text your own tagged number during a test. Still scoped to ONLY_TAGS.
async function getTestContacts() {
  const A = `'${CONFIG.ACCOUNT_ID}'`;
  const rows = await sql(`
    SELECT c.id AS contact_id, NULL AS stage, c.name, c.phone, c.tags,
           NULL AS last_inbound, NULL AS last_outbound,
           999 AS days_since_out, false AS has_replied, false AS has_call,
           (SELECT string_agg(x.body, ' || ') FROM (
              SELECT body FROM messages mi
              WHERE mi.contact_id = c.id AND mi.type='sms' AND mi.direction='inbound'
              ORDER BY mi.timestamp DESC LIMIT 3) x) AS last_inbound_body,
           0 AS unanswered
    FROM contacts c
    WHERE c.account_id = ${A} AND c.tags && ${pgArray(CONFIG.ONLY_TAGS)}
  `);
  return rows.map(r => ({ ...r, force_due: true }));
}

// --------------------------------------------------------------------------
// Step 2: decide the cadence + whether a touch is due
// --------------------------------------------------------------------------
function pickCadence(candidate) {
  const t = (candidate.tags || []).map(x => String(x).toLowerCase().trim());

  // 1) They told us it's handled / caught up -> gentle monthly until they say stop
  if (isHandled(candidate.last_inbound_body)) return 'handled';

  // 2) Specific objection tag
  for (const [tag, cad] of Object.entries(CONFIG.OBJECTION_TAG_TO_CADENCE)) {
    if (t.includes(tag)) return cad;
  }

  // 3) Engaged by text OR phone -> engaged cadence
  const engaged = candidate.has_replied || candidate.has_call;
  if (CONFIG.ENGAGED_OVERRIDE_IF_ENGAGED && engaged) return 'engaged';

  // 3.5) Facebook lead that has NEVER engaged -> steady 14-day drip until they say stop
  const isFb = t.some(x => x.includes('fb lead') || x.includes('facebook'));
  if (isFb && !engaged) return 'fb_drip';

  // 4) Fall back to stage
  return CONFIG.STAGE_TO_CADENCE[candidate.stage] || 'default';
}

function gapForTouch(cadenceKey, unanswered) {
  const cad = CONFIG.CADENCES[cadenceKey] || CONFIG.CADENCES.default;
  const gaps = cad.gaps;
  const idx = Math.min(unanswered, gaps.length - 1);
  return gaps[idx];
}

function hasNeverTag(tags) {
  const t = (tags || []).map(x => String(x).toLowerCase().trim());
  return CONFIG.NEVER_TAGS.map(x => x.toLowerCase().trim()).some(n => t.includes(n));
}

// --------------------------------------------------------------------------
// Step 3: draft the message with Claude
// --------------------------------------------------------------------------
async function draftMessage(candidate, cadenceKey, context) {
  const cad = CONFIG.CADENCES[cadenceKey] || CONFIG.CADENCES.default;
  const touchNumber = Number(candidate.unanswered) + 1;
  const isOffend = cad.offend_on_touch && touchNumber === cad.offend_on_touch;
  const firstName = (candidate.name || 'there').split(' ')[0];
  const _t = (candidate.tags || []).map(x => String(x).toLowerCase().trim());
  const isFbLead = _t.some(x => x.includes('fb lead') || x.includes('facebook'));
  const leadType = isFbLead
    ? 'INBOUND lead. They reached out through our Facebook form and agreed to be contacted, so it is fine to acknowledge they inquired with us.'
    : 'OUTBOUND lead. We reached out first based on a public pre-foreclosure / auction notice.';

  const history = context.msgs.length
    ? context.msgs.map(m => `${m.direction === 'inbound' ? 'Contact' : 'You'}: "${m.body}"`).join('\n')
    : '(no prior messages found)';
  const noteText = context.notes.length
    ? context.notes.map(n => `- ${n.body}`).join('\n')
    : '(no notes on file)';
  const callText = context.calls && context.calls.length
    ? context.calls.map(k => `- [${k.d}] ${k.summary ? k.summary : '(call held, ' + (k.duration || '?') + 's, no summary)'}`).join('\n')
    : '(no phone calls on record)';

  const engagedHow = candidate.has_replied
    ? 'yes — replied by text, then went quiet'
    : (candidate.has_call ? 'yes — spoke with us by PHONE, then went quiet (never texted back)' : 'no — never replied by text or phone');

  const emailInstr = cadenceKey === 'fb_drip'
    ? `

ALSO write a short EMAIL to this person. They filled out our form (usually about mortgage or possible foreclosure trouble) but have never replied to our texts. Make it CONVERSATIONAL and SITUATIONAL, not generic: reference why they reached out, acknowledge life gets busy and their cell probably gets tons of texts and calls, and ask when a good time to connect is. A few warm human sentences. Do NOT paste a URL (a booking link is added automatically under your text) but invite them to book a time and see families we have helped. Sign off as ${CONFIG.BOT_NAME}, ${CONFIG.COMPANY_NAME}. Make the SUBJECT LINE short, attention-grabbing, and DIFFERENT every time, never reuse a subject.
Return ONLY JSON: { "message": "<sms text>", "email_subject": "<subject>", "email_body": "<email body, blank line between paragraphs>" }`
    : `

Return ONLY JSON: { "message": "..." }`;

  const system = `${FOLLOWUP_KB}

CONTACT: ${candidate.name || 'Unknown'} (first name: ${firstName})
PIPELINE STAGE: ${candidate.stage}
LEAD TYPE: ${leadType}
CADENCE: ${cadenceKey}
DAYS SINCE OUR LAST TEXT: ${Math.round(candidate.days_since_out)}
UNANSWERED NUDGES SO FAR: ${candidate.unanswered}  (this will be touch #${touchNumber})
HAVE THEY EVER ENGAGED: ${engagedHow}
${isOffend ? '\n>>> This is the pattern-interrupt touch. A single light "did we do something to offend you?" style line is allowed here.\n' : ''}
CALL HISTORY (AI summaries of phone conversations — use this, it is what was actually said):
${callText}

WHAT WE KNOW (notes):
${noteText}

RECENT TEXT HISTORY (oldest to newest):
${history}

Write the NEXT single follow-up text. Reference what we actually know (calls/notes) when useful.
Do not repeat any line already sent above.${emailInstr}`;

  const resp = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: CONFIG.CLAUDE_MODEL,
      max_tokens: 500,
      system,
      messages: [{ role: 'user', content: `Draft follow-up touch #${touchNumber} (${cadenceKey} cadence).` }]
    },
    { headers: { 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );

  const text = resp.data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let parsed = {};
  try {
    parsed = JSON.parse(text.replace(/```json\n?|```/g, '').trim());
  } catch (e) {
    parsed = { message: text.trim().slice(0, 160) };
  }
  const result = { message: makeMessageHuman(parsed.message || ''), email: null };
  if (cadenceKey === 'fb_drip' && parsed.email_subject && parsed.email_body) {
    result.email = { subject: String(parsed.email_subject).trim(), body: String(parsed.email_body).trim() };
  }
  return result;
}

// --------------------------------------------------------------------------
// Step 4: send it (skipped entirely in DRY RUN)
// --------------------------------------------------------------------------
async function sendSMS(contactId, message) {
  await axios.post(
    'https://services.leadconnectorhq.com/conversations/messages',
    { type: 'SMS', contactId, message },
    { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' } }
  );
}

async function sendEmail(contactId, subject, html) {
  await axios.post(
    'https://services.leadconnectorhq.com/conversations/messages',
    { type: 'Email', contactId, subject, html },
    { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' } }
  );
}

async function addNote(contactId, body) {
  try {
    await axios.post(
      `https://services.leadconnectorhq.com/contacts/${contactId}/notes`,
      { body },
      { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' } }
    );
  } catch (e) { /* non-fatal */ }
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
async function run() {
  console.log(`\n${'='.repeat(64)}`);
  console.log(`🚀 FOLLOW-UP ENGINE — ${CONFIG.DRY_RUN ? '🧪 DRY RUN (no sends)' : '🔴 LIVE'} — ${new Date().toISOString()}`);
  console.log(`${'='.repeat(64)}`);

  if (!STREAMLINED_API_KEY) { console.log('❌ No STREAMLINED_API_KEY. Exiting.'); return; }
  if (!isBusinessHours()) {
    console.log(`⚠️ Outside business hours (${CONFIG.BUSINESS_HOURS.start}:00–${CONFIG.BUSINESS_HOURS.end}:00 ${CONFIG.TIMEZONE}). Exiting.`);
    return;
  }

  let candidates = await getCandidates();
  console.log(`📥 Pulled ${candidates.length} ghosted candidates from target stages`);

  const before = candidates.length;
  candidates = candidates.filter(c => !hasNeverTag(c.tags));
  console.log(`🛑 Removed ${before - candidates.length} with never-contact tags`);

  if (CONFIG.ONLY_TAGS && CONFIG.ONLY_TAGS.length > 0) {
    const allow = CONFIG.ONLY_TAGS.map(x => x.toLowerCase().trim());
    const pre = candidates.length;
    candidates = candidates.filter(c => (c.tags || []).map(x => String(x).toLowerCase().trim()).some(t => allow.includes(t)));
    console.log(`🔒 ONLY_TAGS active [${CONFIG.ONLY_TAGS.join(', ')}] — narrowed ${pre} → ${candidates.length}`);

    // TEST_MODE: also pull in tagged contacts that don't meet the normal stage/ghost rules
    if (CONFIG.TEST_MODE) {
      const testRows = (await getTestContacts()).filter(c => !hasNeverTag(c.tags));
      const known = new Set(candidates.map(c => c.contact_id));
      const extra = testRows.filter(c => !known.has(c.contact_id));
      candidates = candidates.concat(extra);
      console.log(`🧪 TEST_MODE added ${extra.length} tagged contact(s) that bypass stage/ghost rules`);
    }
  }

  // Decide who is actually DUE for a touch right now
  const due = [];
  for (const c of candidates) {
    const cadence = pickCadence(c);
    const cad = CONFIG.CADENCES[cadence] || CONFIG.CADENCES.default;
    const unanswered = Number(c.unanswered);
    if (!c.force_due) {
      if (unanswered >= cad.max_touches) continue;          // exhausted
      const gap = gapForTouch(cadence, unanswered);
      if (Number(c.days_since_out) < gap) continue;         // not time yet
    }
    const engaged = c.has_replied || c.has_call;
    due.push({ ...c, cadence, engaged });
  }
  console.log(`⏰ ${due.length} are due for a follow-up today`);

  due.sort((a, b) => {
    if (CONFIG.PRIORITIZE === 'engaged_first' && a.engaged !== b.engaged) return a.engaged ? -1 : 1;
    if (CONFIG.PRIORITIZE === 'newest_first') return a.days_since_out - b.days_since_out;
    return b.days_since_out - a.days_since_out; // oldest_first (also tiebreak for engaged_first)
  });

  const plan = due.slice(0, CONFIG.DAILY_SEND_CAP);
  console.log(`🎯 Will process ${plan.length} (cap ${CONFIG.DAILY_SEND_CAP})\n`);

  let sent = 0;
  const report = [];
  for (const c of plan) {
    try {
      const context = await getContext(c.contact_id);
      const drafted = await draftMessage(c, c.cadence, context);
      const message = drafted.message;
      const icon = c.engaged ? (c.has_call && !c.has_replied ? '📞' : '💬') : '🧊';
      let line = `${icon} [${c.cadence}] ${c.name || c.contact_id} | ${c.stage} | ${Math.round(c.days_since_out)}d | touch#${Number(c.unanswered)+1} → "${message}"`;
      if (drafted.email) line += `\n     ✉️ "${drafted.email.subject}" — ${drafted.email.body.replace(/\s+/g,' ').slice(0,150)}...`;
      console.log(line);
      report.push(line);

      if (!CONFIG.DRY_RUN) {
        await sendSMS(c.contact_id, message);
        await addNote(c.contact_id, `AI follow-up sent (${c.cadence}, touch #${Number(c.unanswered)+1}): ${message}`);
        // On FB drip touches, also send the AI-written conversational email + booking link
        if (c.cadence === 'fb_drip' && CONFIG.SEND_GHOST_EMAIL && c.email && drafted.email) {
          try {
            const bodyHtml = drafted.email.body.split(/\n\s*\n/).map(p => `<p>${p.trim().replace(/\n/g,'<br>')}</p>`).join('')
              + `<p><a href="${CONFIG.OPTIONS_LINK}">Book a time and see families we've helped</a></p>`;
            await sendEmail(c.contact_id, drafted.email.subject, bodyHtml);
            console.log(`   ✉️ ghost email sent ("${drafted.email.subject}")`);
          } catch (e) { console.error(`   ✉️ email failed: ${e.message}`); }
        }
        sent++;
        await sleep(CONFIG.SEND_DELAY_SECONDS);
      }
    } catch (e) {
      console.error(`❌ ${c.name || c.contact_id}: ${e.message}`);
    }
  }

  console.log(`\n${'='.repeat(64)}`);
  if (CONFIG.DRY_RUN) {
    console.log(`🧪 DRY RUN complete. ${plan.length} messages drafted, 0 sent.`);
    try { fs.writeFileSync('./last-dry-run.txt', report.join('\n')); console.log('📝 Wrote plan to last-dry-run.txt'); } catch (e) {}
  } else {
    console.log(`✅ LIVE run complete. Sent ${sent} messages.`);
  }
  console.log(`${'='.repeat(64)}\n`);
}

run()
  .then(() => { console.log('👍 Done'); process.exit(0); })
  .catch(err => { console.error('💥 Failed:', err.message); process.exit(1); });
