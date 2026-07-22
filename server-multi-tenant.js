// server-multi-tenant.js - FINAL CLEAN VERSION
// Combines all working logic from single-tenant + proper multi-tenant setup

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const app = express();

app.use(express.json());

// CLAUDE API KEY (shared by all clients)
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// AI on/off switch: only respond to contacts carrying one of these tags
const AI_ENABLE_TAGS = ['pfc ai', 'home seller ai'];

// GHL calendar for AI-booked phone appointments (Custom Action Plan - Phone Appt)
const CALENDAR_ID = 'UqgEPH7UZA5U6M5p9jkg';
// Assign appointments to the "Team Caruth Brothers Real Estate" user so they land on the
// whole team's Google calendars (matches all existing bookings on this calendar).
const CALENDAR_TEAM_USER_ID = 'TfrfJn4xcgwlUU0Rq7rl';
const APPT_DURATION_MIN = 30; // length of a booked phone appointment

// Working hours (contact's local time). Text replies 7:00am-10:30pm; scheduled calls 7:30am-9:30pm.
const TEXT_START_MIN = 7 * 60;         // 7:00am
const TEXT_END_MIN   = 22 * 60 + 30;   // 10:30pm
const CALL_START_MIN = 7 * 60 + 30;    // 7:30am
const CALL_END_MIN   = 21 * 60 + 30;   // 9:30pm
function nowMinutesInTz(tz) {
  const p = new Date().toLocaleString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: false }).match(/(\d{1,2}):(\d{2})/);
  if (!p) return 12 * 60;
  let h = parseInt(p[1]); if (h === 24) h = 0;
  return h * 60 + parseInt(p[2]);
}

// CLIENT CONFIGURATIONS
const CLIENTS = {
  'caruth': {
    name: 'Caruth Brothers LLC',
    ghl_api_key: process.env.CARUTH_GHL_API_KEY,
    location_id: 'OuIxba3Lr0bnZvndMh3Z',
    assigned_user_id: 'XeVxOOIGpT0fbigXVjK6', 
    knowledge_base_file: './knowledge-base-master.txt',
    bot_name: 'Peter',
    company_name: 'Caruth Brothers',
    max_messages_per_day: 6,
    timezone: 'America/Chicago',
    response_delay: { min: 9, max: 20 },
    stop_tags: ['stop bot', 'stop_bot', 'do not contact', 'do_not_contact', 'dnd', 'dnd enabled', 'manual takeover', 'manual_takeover']
  },
  'client1': {
    name: 'Client 1 Name',
    ghl_api_key: process.env.CLIENT1_GHL_API_KEY,
    location_id: null,
    assigned_user_id: null,
    knowledge_base_file: './knowledge-base-master.txt',
    bot_name: 'Sarah',
    company_name: 'ABC Realty',
    max_messages_per_day: 6,
    timezone: 'America/Chicago',
    response_delay: { min: 5, max: 20 },
    stop_tags: ['stop bot', 'stop_bot', 'do not contact', 'do_not_contact', 'dnd', 'dnd enabled', 'manual takeover', 'manual_takeover']
  },
  'client2': {
    name: 'Client 2 Name',
    ghl_api_key: process.env.CLIENT2_GHL_API_KEY,
    location_id: null,
    assigned_user_id: null,
    knowledge_base_file: './knowledge-base-master.txt',
    bot_name: 'Mike',
    company_name: 'XYZ Investments',
    max_messages_per_day: 3,
    timezone: 'America/Chicago',
    response_delay: { min: 10, max: 30 },
    stop_tags: ['stop bot', 'stop_bot', 'do not contact', 'do_not_contact', 'dnd', 'dnd enabled', 'manual takeover', 'manual_takeover']
  }
};

// ============================================================================
// KNOWLEDGE BASES (keyed by SEGMENT, not client)
// pfc         = pre-foreclosure script (default)
// home_seller = off-market seller script (used when contact has "home seller ai" tag)
// ============================================================================
function safeRead(path) {
  try {
    const kb = fs.readFileSync(path, 'utf8');
    console.log(`✅ Loaded KB: ${path} (${kb.length} chars)`);
    return kb;
  } catch (e) {
    console.log(`⚠️ Missing KB: ${path}`);
    return 'You are a real estate specialist helping homeowners.';
  }
}

const KNOWLEDGE_BASES = {
  pfc:         safeRead('./knowledge-base-master.txt'),
  home_seller: safeRead('./knowledge-base-home-seller.txt')
};

// Stop keywords that auto-trigger stop_bot
const STOP_KEYWORDS = [
  'stop', 'unsubscribe', 'remove me', 'dont contact', 'stop texting',
  'cease and desist', 'lawyer', 'harassment', 'wrong number',
  'already sold', 'not in foreclosure', 'caught up', 'refinanced'
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

// Helper: Random delay
function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

// Helper: Make message sound human (remove robotic punctuation)
function makeMessageHuman(message) {
  if (!message) return message;
  
  let cleaned = message;
  
  // Remove dashes used as separators
  cleaned = cleaned.replace(/(\w+)\s*-\s+(\w+)/g, '$1 $2');
  
  // Remove semicolons
  cleaned = cleaned.replace(/;/g, ',');
  
  // Remove em/en dashes
  cleaned = cleaned.replace(/—/g, ' ');
  cleaned = cleaned.replace(/–/g, ' ');
  
  // Remove excessive ellipses
  cleaned = cleaned.replace(/\.{3,}/g, '');
  
  // Clean up double spaces
  cleaned = cleaned.replace(/\s{2,}/g, ' ');
  
  // Replace overly formal phrases
  const casualReplacements = {
    'Yes - ': 'Yeah ',
    'Yes, ': 'Yeah ',
    'I understand - ': 'I get it ',
    'I understand, ': 'I get it, ',
    'Great; ': 'Great ',
    'Certainly - ': '',
    'Certainly, ': '',
    'However, ': 'But ',
    'Nevertheless, ': 'But '
  };
  
  for (const [formal, casual] of Object.entries(casualReplacements)) {
    cleaned = cleaned.replace(new RegExp(formal, 'gi'), casual);
  }
  
  return cleaned.trim();
}

// Helper: Get conversation phone number
async function getConversationPhone(contact_id, GHL_API_KEY) {
  try {
    console.log(`🔍 Looking up conversation for contact: ${contact_id}`);
    
    const response = await axios.get(
      'https://services.leadconnectorhq.com/conversations/search',
      {
        params: { contactId: contact_id },
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28'
        }
      }
    );

    if (response.data.conversations && response.data.conversations.length > 0) {
      const conversation = response.data.conversations[0];
      const phone = conversation.locationPhone || 
                   conversation.phone || 
                   conversation.businessPhone ||
                   null;
      
      if (phone) {
        console.log(`✅ Found receiving phone: ${phone}`);
        return phone;
      } else {
        console.log(`⚠️ Conversation found but no phone number in data`);
        return null;
      }
    } else {
      console.log(`⚠️ No conversations found for contact`);
      return null;
    }
  } catch (error) {
    console.error('❌ Error getting conversation phone:', error.message);
    return null;
  }
}

// Helper: Get conversation history via Streamlined API (gets ALL messages!)
async function getConversationHistory(contact_id, GHL_API_KEY) {
  try {
    console.log(`📜 Fetching conversation history via Streamlined for: ${contact_id}`);
    
    const STREAMLINED_API_KEY = process.env.STREAMLINED_API_KEY;
    
    if (!STREAMLINED_API_KEY) {
      console.log(`⚠️ No Streamlined API key - falling back to empty history`);
      return [];
    }

    const sql = `
      SELECT direction, body, timestamp
      FROM messages
      WHERE contact_id = '${contact_id}'
      ORDER BY timestamp ASC
      LIMIT 20
    `;

    const response = await axios.post(
      'https://gateway.streamlined.so/query/api/execute-sql',
      { sql },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': STREAMLINED_API_KEY
        }
      }
    );

    if (response.data.status === 'error') {
      console.error(`❌ Streamlined API error:`, response.data.error);
      return [];
    }

    const messages = response.data.result || [];
    console.log(`✅ Fetched ${messages.length} messages from Streamlined`);

    if (messages.length === 0) {
      return [];
    }

    // Format messages
    const formattedHistory = messages.map(msg => {
      const direction = msg.direction === 'inbound' ? 'Contact' : 'You';
      return `${direction}: "${msg.body}"`;
    });

    console.log(`✅ Formatted ${formattedHistory.length} messages from history`);
    return formattedHistory;

  } catch (error) {
    console.error('❌ Error fetching from Streamlined:', error.message);
    return [];
  }
}
// Runaway-loop guard: settings + helper. Prevents rapid-fire looping (auto-responders,
// trolls, bot-vs-bot) without ever blocking a normal conversation. Hands off to a human.
const LOOP_MAX = 12;            // max outbound texts to one contact within the window
const LOOP_WINDOW_MIN = 30;     // rolling window in minutes
async function countRecentOutbound(contact_id, account_id) {
  try {
    const KEY = process.env.STREAMLINED_API_KEY;
    if (!KEY) return 0;
    const q = `SELECT COUNT(*) AS n FROM messages WHERE contact_id='${contact_id}' AND account_id='${account_id}' AND type='sms' AND direction='outbound' AND timestamp > NOW() - INTERVAL '${LOOP_WINDOW_MIN} minutes'`;
    const resp = await axios.post('https://gateway.streamlined.so/query/api/execute-sql', { sql: q }, { headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY } });
    if (resp.data && resp.data.status === 'error') return 0;
    const rows = (resp.data && resp.data.result) || [];
    return rows.length ? parseInt(rows[0].n) : 0;
  } catch (e) { return 0; }
}

// Helper: Check if should respond
async function shouldRespond(contact_id, client, GHL_API_KEY) {
  try {
    const response = await axios.get(
      `https://services.leadconnectorhq.com/contacts/${contact_id}`,
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28'
        }
      }
    );

    const contact = response.data.contact;
    const contactTags = contact.tags || [];

    // Normalize tags so matching is reliable regardless of casing/spacing
    const normalizedTags = contactTags.map(t => String(t).toLowerCase().trim());
    const stopTags = client.stop_tags.map(t => String(t).toLowerCase().trim());
    const hasStopTag = stopTags.some(tag => normalizedTags.includes(tag));

    // Also honor GHL's native Do-Not-Disturb flag
    const dndFlag = contact.dnd === true;

    if (hasStopTag || dndFlag) {
      const reason = (dndFlag && !hasStopTag) ? 'Contact has DND enabled' : 'Has stop tag';
      return { shouldRespond: false, reason, tags: contactTags };
    }

    return { shouldRespond: true, tags: contactTags };

  } catch (error) {
    console.error('Error checking contact:', error.message);
    return { shouldRespond: false, reason: 'Error checking contact', tags: [] };
  }
}

// Helper: Create GHL Task
// Helper: find the human rep who last worked this lead (last MANUAL text or any call).
// Falls back to null if it's been all-bot, so the task goes to the default owner.
async function getWorkingUserId(contact_id, account_id) {
  try {
    const KEY = process.env.STREAMLINED_API_KEY;
    if (!KEY) return null;
    const q = `SELECT user_id FROM (
      SELECT user_id, timestamp AS ts FROM messages
        WHERE contact_id='${contact_id}' AND account_id='${account_id}' AND direction='outbound' AND source='manual' AND user_id IS NOT NULL
      UNION ALL
      SELECT user_id, created_at AS ts FROM calls
        WHERE contact_id='${contact_id}' AND account_id='${account_id}' AND user_id IS NOT NULL
    ) t ORDER BY ts DESC LIMIT 1`;
    const resp = await axios.post('https://gateway.streamlined.so/query/api/execute-sql', { sql: q }, { headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY } });
    if (resp.data && resp.data.status === 'error') return null;
    const rows = (resp.data && resp.data.result) || [];
    return rows.length && rows[0].user_id ? rows[0].user_id : null;
  } catch (e) { return null; }
}

async function createGHLTask(contact_id, action, client, GHL_API_KEY, assignedUserId) {
  const timeZone = client.timezone || 'America/Chicago';
  const now = new Date();

  // How far the client's timezone is from UTC right now (auto-handles CST vs CDT)
  const offsetMs = now.getTime() - new Date(now.toLocaleString('en-US', { timeZone })).getTime();

  // Build the due time using the client's wall clock
  let due = new Date(now.toLocaleString('en-US', { timeZone }));

  if (action.due_days) {
    due.setDate(due.getDate() + action.due_days);
  }

  if (action.call_time) {
    const timeMatch = action.call_time.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2] || '0');
      const meridiem = timeMatch[3].toLowerCase();
      if (meridiem === 'pm' && hours !== 12) hours += 12;
      if (meridiem === 'am' && hours === 12) hours = 0;
      due.setHours(hours, minutes, 0, 0);
    }
  }

  // Keep scheduled CALLS inside 7:30am - 9:30pm (follow-up tasks with no call_time are left as-is)
  if (action.call_time) {
    const lm = due.getHours() * 60 + due.getMinutes();
    if (lm < CALL_START_MIN) due.setHours(7, 30, 0, 0);
    else if (lm > CALL_END_MIN) { due.setDate(due.getDate() + 1); due.setHours(7, 30, 0, 0); }
  }

  // Convert that client wall-clock time back to a true UTC timestamp for GHL
  const dueUTC = new Date(due.getTime() + offsetMs);
  const dueDateISO = dueUTC.toISOString();

  // Plain-English log so you can confirm the time without doing UTC math
  const readable = dueUTC.toLocaleString('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });

  try {
    await axios.post(
      `https://services.leadconnectorhq.com/contacts/${contact_id}/tasks`,
      {
        title: action.title,
        body: action.notes || '',
        dueDate: dueDateISO,
        completed: false,
        assignedTo: assignedUserId || client.assigned_user_id
      },
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        }
      }
    );
    console.log(`✅ Created task: ${action.title} — due ${readable} (${timeZone})`);
    return true;
  } catch (error) {
    console.error('❌ Error creating task:', error.response?.data || error.message);
    return false;
  }
}

// Helper: Add GHL Note
async function addGHLNote(contact_id, notes, GHL_API_KEY) {
  try {
    await axios.post(
      `https://services.leadconnectorhq.com/contacts/${contact_id}/notes`,
      { body: notes },
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        }
      }
    );
    console.log(`✅ Added note to contact`);
    return true;
  } catch (error) {
    console.error('❌ Error adding note:', error.message);
    return false;
  }
}

// Helper: Add GHL Tag(s)
async function addGHLTag(contact_id, tag, GHL_API_KEY) {
  if (!tag) return false;
  const tags = Array.isArray(tag) ? tag : [tag];
  try {
    await axios.post(
      `https://services.leadconnectorhq.com/contacts/${contact_id}/tags`,
      { tags },
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        }
      }
    );
    console.log(`✅ Added tag(s): ${tags.join(', ')}`);
    return true;
  } catch (error) {
    console.error('❌ Error adding tag:', error.message);
    return false;
  }
}

// Helper: Execute Actions
// Helper: Book a real appointment on the GHL calendar (mirrors createGHLTask's time math).
// Returns true if booked, false on any failure (caller falls back to a task).
async function bookGHLAppointment(contact_id, action, client, GHL_API_KEY, assignedUserId) {
  if (!CALENDAR_ID) return false;
  const timeZone = client.timezone || 'America/Chicago';
  const now = new Date();
  const offsetMs = now.getTime() - new Date(now.toLocaleString('en-US', { timeZone })).getTime();
  let start = new Date(now.toLocaleString('en-US', { timeZone }));
  if (action.due_days) start.setDate(start.getDate() + action.due_days);
  const m = (action.call_time || '').match(/(\d{1,2}):?(\d{2})?\s*(am|pm)/i);
  if (m) {
    let hours = parseInt(m[1]);
    const minutes = parseInt(m[2] || '0');
    const meridiem = m[3].toLowerCase();
    if (meridiem === 'pm' && hours !== 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    start.setHours(hours, minutes, 0, 0);
  }
  // Keep calls inside 7:30am - 9:30pm: pull earlier/later requests into the window
  {
    const lm = start.getHours() * 60 + start.getMinutes();
    if (lm < CALL_START_MIN) start.setHours(7, 30, 0, 0);
    else if (lm > CALL_END_MIN) { start.setDate(start.getDate() + 1); start.setHours(7, 30, 0, 0); }
  }
  const startUTC = new Date(start.getTime() + offsetMs);
  const endUTC = new Date(startUTC.getTime() + APPT_DURATION_MIN * 60 * 1000);
  const readable = startUTC.toLocaleString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  try {
    await axios.post(
      'https://services.leadconnectorhq.com/calendars/events/appointments',
      {
        calendarId: CALENDAR_ID,
        locationId: client.location_id,
        contactId: contact_id,
        startTime: startUTC.toISOString(),
        endTime: endUTC.toISOString(),
        title: action.title || 'Phone appointment',
        appointmentStatus: 'confirmed',
        assignedUserId: CALENDAR_TEAM_USER_ID,  // Team Caruth -> shows on everyone's calendar
        ignoreDateRange: true,
        toNotify: true
      },
      { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-04-15' } }
    );
    console.log(`📅 Booked appointment on calendar - ${readable} (${timeZone})`);
    return true;
  } catch (error) {
    console.error('❌ Appointment booking failed:', error.response?.data || error.message);
    return false;
  }
}

async function executeActions(contact_id, contact_email, actions, client, GHL_API_KEY) {
  if (!actions || actions.length === 0) return;
  
  console.log(`🎬 Executing ${actions.length} action(s)...`);
  
  let appointmentBooked = false;

  // Who's actually working this lead? Assign tasks to them, else default owner (Peter).
  const workingUserId = await getWorkingUserId(contact_id, client.location_id);
  if (workingUserId) console.log(`👤 Assigning tasks to working rep: ${workingUserId}`);
  else console.log('👤 No human rep found - assigning to default owner');
  
  for (const action of actions) {
    switch (action.type) {
      case 'create_task': {
        if (action.call_time) {
          // Scheduled call -> book a REAL calendar appointment
          const booked = await bookGHLAppointment(contact_id, action, client, GHL_API_KEY, workingUserId);
          if (booked) {
            appointmentBooked = true;
          } else {
            // Booking failed -> fall back to a task so we never lose the appointment
            const taskCreated = await createGHLTask(contact_id, action, client, GHL_API_KEY, workingUserId);
            if (taskCreated) appointmentBooked = true;
          }
        } else {
          // Follow-up task (no scheduled call time) -> just a task
          await createGHLTask(contact_id, action, client, GHL_API_KEY, workingUserId);
        }
        break;
      }
      case 'add_note':
        await addGHLNote(contact_id, action.notes, GHL_API_KEY);
        break;
      case 'add_tag':
        await addGHLTag(contact_id, action.tag, GHL_API_KEY);
        break;
      default:
        console.log(`⚠️ Unknown action type: ${action.type}`);
    }
  }
  
  // Add appointment booked tag if a scheduled-call task was created
  if (appointmentBooked) {
    try {
      await axios.post(
        `https://services.leadconnectorhq.com/contacts/${contact_id}/tags`,
        { tags: ['appointment booked'] },
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          }
        }
      );
      console.log(`✅ Added "appointment booked" tag`);
    } catch (error) {
      console.error('❌ Error adding appointment booked tag:', error.message);
    }
  }
}

// ============================================================================
// MAIN WEBHOOK HANDLER
// ============================================================================

app.post('/webhook', async (req, res) => {
  const startTime = Date.now();
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📨 NEW SMS RECEIVED - ${new Date().toISOString()}`);
  console.log(`${'='.repeat(60)}`);
  
  const client_id = req.body.client_id || 'caruth';
  const contact_id = req.body.contact_id;
  const message_body = req.body.message_body;
  const contact_name = req.body.contact_name || 'there';
  const phone = req.body.phone;
  const property_address = req.body.property_address;
  
  if (!CLIENTS[client_id]) {
    console.log(`❌ Unknown client_id: ${client_id}`);
    return res.status(400).json({ error: 'Unknown client_id' });
  }
  
  const client = CLIENTS[client_id];
  const GHL_API_KEY = client.ghl_api_key;
  
  console.log(`🏢 Client: ${client.name}`);
  console.log(`👤 From: ${contact_name} (${contact_id})`);
  console.log(`📱 Phone: ${phone}`);
  console.log(`💬 Message: "${message_body}"`);
  
  // Respond immediately to prevent GHL timeout
  res.json({ success: true, message: 'Processing' });
  
  // Process async
  (async () => {
    try {
      // Check if should respond (also returns the contact's tags)
      const check = await shouldRespond(contact_id, client, GHL_API_KEY);
      
      if (!check.shouldRespond) {
        console.log(`❌ Not responding: ${check.reason}`);
        return;
      }

      // Pick the script based on the contact's tags
      // "home seller ai" -> off-market seller KB, everyone else -> PFC KB
      const contactTags = check.tags || [];

      // POSITIVE GATE: only the AI-enabled tags get a response
      const enableTags = contactTags.map(t => String(t).toLowerCase().trim());
      if (!AI_ENABLE_TAGS.some(t => enableTags.includes(t))) {
        console.log('❌ Not responding: contact has no "pfc ai" or "home seller ai" tag');
        return;
      }

      const segment = contactTags.includes('home seller ai') ? 'home_seller' : 'pfc';
      const KNOWLEDGE_BASE = KNOWLEDGE_BASES[segment];
      console.log(`📚 Segment: ${segment}`);

      // Texting-hours guard: only reply between 7:00am and 10:30pm (their local time)
      const nowMin = nowMinutesInTz(client.timezone || 'America/Chicago');
      if (nowMin < TEXT_START_MIN || nowMin > TEXT_END_MIN) {
        console.log(`🌙 Outside texting hours - holding off, not replying right now`);
        return;
      }

      // Detect lead source so the bot frames replies correctly
      const normTags = contactTags.map(t => String(t).toLowerCase().trim());
      const isFacebookLead = normTags.some(t => t.includes('fb lead') || t.includes('facebook'));
      const leadSource = isFacebookLead
        ? 'INBOUND Facebook lead. They filled out our form online, so our first message referenced their form submission. Do NOT talk as if this is a cold outreach about a county notice.'
        : 'OUTBOUND lead. We reached out first based on a public pre-foreclosure / auction notice. They did not contact us first, so it is normal if they do not recognize us at first.';
      console.log(`🧭 Lead source: ${isFacebookLead ? 'Facebook inquiry' : 'Outbound'}`);

      // Runaway-loop guard: hand off to a human if we are rapid-fire looping with this contact
      const recentOutbound = await countRecentOutbound(contact_id, client.location_id);
      if (recentOutbound >= LOOP_MAX) {
        console.log(`🔁 Loop guard tripped (${recentOutbound} outbound in ${LOOP_WINDOW_MIN}min) - tagging "speak now", handing to human`);
        try {
          await axios.post(
            `https://services.leadconnectorhq.com/contacts/${contact_id}/tags`,
            { tags: ['speak now'] },
            { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' } }
          );
        } catch (e) { console.error('loop-guard tag error:', e.message); }
        return;
      }

      // Get conversation phone
      const conversationPhone = await getConversationPhone(contact_id, GHL_API_KEY);
      
      if (!conversationPhone) {
        console.log(`⚠️ Could not determine receiving phone - using default`);
      } else {
        console.log(`✅ Will reply from: ${conversationPhone}`);
      }

      // Get conversation history (CRITICAL!)
      const conversationHistory = await getConversationHistory(contact_id, GHL_API_KEY);

      // Random delay
      const delay = getRandomDelay(client.response_delay.min, client.response_delay.max);
      console.log(`⏳ Waiting ${delay/1000}s before responding...`);
      await new Promise(resolve => setTimeout(resolve, delay));

      console.log(`🤖 Calling Claude API...`);

      // Build history string
      const historyString = conversationHistory.length > 0
        ? `\n\nCONVERSATION HISTORY (from oldest to newest):\n${conversationHistory.join('\n')}\n`
        : '\n\n(No previous conversation history - this is first contact)\n';

      // Call Claude API
      const claudeResponse = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
         system: `You are ${client.bot_name} from ${client.company_name}.

TODAY'S DATE: ${new Date().toLocaleDateString('en-US', { 
  weekday: 'long', 
  year: 'numeric', 
  month: 'long', 
  day: 'numeric',
  timeZone: client.timezone || 'America/Chicago'
})}

CALCULATING DUE_DAYS:
- "today" or "this afternoon" → due_days: 0
- "tomorrow" → due_days: 1
- "Friday" when today is Wednesday → due_days: 2
- Count the actual days between today and the requested day.

KNOWLEDGE BASE:
${KNOWLEDGE_BASE}

CONTACT INFO:
- Name: ${contact_name}
- Phone: ${phone}
- Property: ${property_address || 'Not provided'}
- Lead source: ${leadSource}
${historyString}
CRITICAL RULES:
1. ALWAYS READ THE CONVERSATION HISTORY ABOVE before responding
2. NEVER restart a conversation if there is existing history
3. If their message seems random or confusing, CHECK THE HISTORY to see if they're answering a previous question
4. If you cannot understand what they mean even with history, add tag "speak now" to alert the team
5. NEVER use dashes (-), semicolons (;), or em dashes (—) in your messages
6. Sound like a human texting casually - not a grammar bot
7. Keep response under 160 characters when possible
8. Use casual language: "Yeah" not "Yes", "I get it" not "I understand"
9. Reference their name naturally in conversation
10. NOTES - be selective, do NOT note every message. Do NOT add a note for routine stuff (greetings, "ok"/"yes", scheduling or confirming a time, acknowledgments, emojis, small talk, or a plain "idk"). Add AT MOST ONE short add_note action, and ONLY when the contact reveals something genuinely note-worthy from this list:
   - Situation: how far behind, loan balance, monthly payment, sale/auction date, other liens
   - What they are doing about it: loan mod, bankruptcy, reinstatement, working with the lender / an attorney / a realtor, listed or on the market, already under contract
   - Intent: wants to sell, wants to keep the house, wants an offer, not interested, wants us to stop
   - A firm commitment or next step: e.g. will send a mortgage statement, will call the bank back
   - A major personal circumstance that actually affects the deal or timing (keep it brief)
   If their latest message contains none of the above, do NOT include an add_note action.
11. ALWAYS prioritize getting them on the phone. Accept WHATEVER time they give you (3:15, 3:45, tonight, tomorrow, whenever) and confirm it naturally, e.g. "Sounds good, I'll give you a call at 3:15." Then set the appointment/task for that exact time. There is NO calendar-availability limit on your end, so NEVER tell a contact a time isn't available, that we don't have that slot, or that you can't do a call at their requested time. Do not let scheduling logistics ever stop you from locking in a call. If they give a specific time, treat it as a scheduled call (include call_time).
12. CALL HOURS: only propose or confirm call times between 7:30am and 9:30pm their time. If they ask for a time outside that (like 6am or 11pm), do NOT refuse - offer the closest time that works, e.g. "I can do first thing at 7:30" or "how about 9pm tonight, or first thing in the morning?" Always still aim to lock in the call.

RESPONSE FORMAT (JSON ONLY):
{
  "message": "Your SMS response here",
  "tag": "answered yes|answered no|wrong number|spam troll|neutral response|speak now|appointment booked|do not contact",
  "stop_bot": false,
  "actions": [] // Optional - include for notes, follow-up tasks, booking calls
}

IMPORTANT: Respond ONLY with valid JSON. No markdown, no explanations, just the JSON object.`,
          messages: [
            {
              role: 'user',
              content: `Contact just texted: "${message_body}"\n\nRespond appropriately in JSON format.`
            }
          ]
        },
        {
          headers: {
            'x-api-key': CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          }
        }
      );

      console.log(`✅ Claude responded`);

      // Extract response
      const responseContent = claudeResponse.data.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      console.log(`📝 Response content: ${responseContent}`);

      // Parse JSON
      let responseData;
      try {
        const cleanJson = responseContent.replace(/```json\n?|```\n?/g, '').trim();
        responseData = JSON.parse(cleanJson);
      } catch (e) {
        console.log('⚠️ Could not parse JSON, using raw response');
        responseData = {
          message: responseContent.substring(0, 160),
          tag: 'neutral response',
          stop_bot: false
        };
      }

      console.log(`📋 Parsed response:`, JSON.stringify(responseData, null, 2));

      // Check for stop request
      if (responseData.stop_bot) {
        console.log('🛑 Contact requested stop');
        // Apply the real GHL tags so both this bot and your GHL workflows honor the stop
        await addGHLTag(contact_id, ['do not contact', 'stop bot'], GHL_API_KEY);
        // Optionally send a brief closing message if Claude provided one
        if (responseData.message && responseData.message.trim().length > 0) {
          try {
            const stopPayload = { type: 'SMS', contactId: contact_id, message: makeMessageHuman(responseData.message) };
            if (conversationPhone) stopPayload.from = conversationPhone;
            await axios.post(
              'https://services.leadconnectorhq.com/conversations/messages',
              stopPayload,
              { headers: { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Content-Type': 'application/json', 'Version': '2021-07-28' } }
            );
            console.log('✅ Sent closing message before stopping');
          } catch (e) {
            console.error('⚠️ Could not send closing message:', e.message);
          }
        }
        console.log('✅ Applied stop tags, halting bot for this contact');
        return;
      }

      // Clean message to sound human
      const originalMessage = responseData.message;
      responseData.message = makeMessageHuman(responseData.message);
      
      if (originalMessage !== responseData.message) {
        console.log(`🧹 Cleaned message: "${originalMessage}" → "${responseData.message}"`);
      }

      // Send SMS
      console.log(`📱 Sending SMS: "${responseData.message}"`);
      
      const smsPayload = {
        type: 'SMS',
        contactId: contact_id,
        message: responseData.message
      };

      if (conversationPhone) {
        smsPayload.from = conversationPhone;
      }

      await axios.post(
        'https://services.leadconnectorhq.com/conversations/messages',
        smsPayload,
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          }
        }
      );

      console.log(`✅ SMS sent successfully`);

      // Execute actions if any
      if (responseData.actions && responseData.actions.length > 0) {
        console.log(`🎬 Processing ${responseData.actions.length} action(s)...`);
        
        // Get contact email for appointment booking
        let contactEmail = null;
        try {
          const contactResponse = await axios.get(
            `https://services.leadconnectorhq.com/contacts/${contact_id}`,
            {
              headers: {
                'Authorization': `Bearer ${GHL_API_KEY}`,
                'Version': '2021-07-28'
              }
            }
          );
          contactEmail = contactResponse.data.contact?.email || null;
          if (contactEmail) {
            console.log(`📧 Contact email: ${contactEmail}`);
          } else {
            console.log(`⚠️ No email on file for contact`);
          }
        } catch (error) {
          console.error('⚠️ Could not fetch contact email:', error.message);
        }
        
        await executeActions(contact_id, contactEmail, responseData.actions, client, GHL_API_KEY);
      }

      // Add intent tag
      if (responseData.tag) {
        console.log(`🏷️ Adding tag: ${responseData.tag}`);
        await axios.post(
          `https://services.leadconnectorhq.com/contacts/${contact_id}/tags`,
          { tags: [responseData.tag] },
          {
            headers: {
              'Authorization': `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
              'Version': '2021-07-28'
            }
          }
        );
        console.log(`✅ Tag added`);
      }

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`✅ COMPLETE - Total: ${totalTime}s, Delay: ${delay/1000}s, Tag: ${responseData.tag}`);
      console.log(`${'='.repeat(60)}\n`);

    } catch (error) {
      console.error('❌ ERROR:', error.response?.data || error.message);
      console.log(`${'='.repeat(60)}\n`);
    }
  })();
});

// Health check
app.get('/', (req, res) => {
  const clientCount = Object.keys(CLIENTS).length;
  const kbSizes = Object.entries(KNOWLEDGE_BASES).map(([segment, kb]) => 
    `${segment}: ${kb.length} chars`
  ).join(', ');
  
  res.json({ 
    status: 'Multi-Tenant SMS Bot - Running',
    version: '3.1.0-SEGMENTED-KB',
    clients: clientCount,
    client_list: Object.keys(CLIENTS),
    knowledge_bases: kbSizes,
    timestamp: new Date().toISOString()
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 MULTI-TENANT SMS BOT - FINAL CLEAN VERSION`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`👥 Serving ${Object.keys(CLIENTS).length} clients:`);
  Object.entries(CLIENTS).forEach(([id, config]) => {
    console.log(`   - ${id}: ${config.name} (${config.bot_name})`);
  });
  console.log(`📋 Knowledge Bases Loaded (by segment):`);
  Object.entries(KNOWLEDGE_BASES).forEach(([segment, kb]) => {
    console.log(`   - ${segment}: ${kb.length} characters`);
  });
  console.log(`\n✅ Ready to receive webhooks!`);
  console.log(`${'='.repeat(60)}\n`);
});
