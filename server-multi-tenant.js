// server-multi-tenant.js - FINAL CLEAN VERSION
// Combines all working logic from single-tenant + proper multi-tenant setup

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const app = express();

app.use(express.json());

// CLAUDE API KEY (shared by all clients)
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// CLIENT CONFIGURATIONS
const CLIENTS = {
  'caruth': {
    name: 'Caruth Brothers LLC',
    ghl_api_key: process.env.CARUTH_GHL_API_KEY,
    knowledge_base_file: './knowledge-base-caruth.txt',
    bot_name: 'Peter',
    company_name: 'Caruth Brothers',
    max_messages_per_day: 6,
    timezone: 'America/Chicago',
    response_delay: { min: 5, max: 20 },
    stop_tags: ['stop_bot', 'dnd', 'manual_takeover', 'do_not_contact']
  },
  'client1': {
    name: 'Client 1 Name',
    ghl_api_key: process.env.CLIENT1_GHL_API_KEY,
    knowledge_base_file: './knowledge-base-master.txt',
    bot_name: 'Sarah',
    company_name: 'ABC Realty',
    max_messages_per_day: 6,
    timezone: 'America/Chicago',
    response_delay: { min: 5, max: 20 },
    stop_tags: ['stop_bot', 'dnd', 'manual_takeover', 'do_not_contact']
  },
  'client2': {
    name: 'Client 2 Name',
    ghl_api_key: process.env.CLIENT2_GHL_API_KEY,
    knowledge_base_file: './knowledge-base-master.txt',
    bot_name: 'Mike',
    company_name: 'XYZ Investments',
    max_messages_per_day: 3,
    timezone: 'America/Chicago',
    response_delay: { min: 10, max: 30 },
    stop_tags: ['stop_bot', 'dnd', 'manual_takeover', 'do_not_contact']
  }
};

// Load knowledge bases at startup
const KNOWLEDGE_BASES = {};
for (const [clientId, config] of Object.entries(CLIENTS)) {
  try {
    KNOWLEDGE_BASES[clientId] = fs.readFileSync(config.knowledge_base_file, 'utf8');
    console.log(`✅ Loaded knowledge base for ${config.name}`);
  } catch (e) {
    console.log(`⚠️ Knowledge base not found for ${clientId}, using default`);
    KNOWLEDGE_BASES[clientId] = 'You are a pre-foreclosure specialist helping distressed homeowners.';
  }
}

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

// Helper: Get conversation history (FULL VERSION - 20 messages)
async function getConversationHistory(contact_id, GHL_API_KEY) {
  try {
    console.log(`📜 Fetching conversation history for contact: ${contact_id}`);
    
    // Get conversation ID
    const convResponse = await axios.get(
      'https://services.leadconnectorhq.com/conversations/search',
      {
        params: { contactId: contact_id },
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28'
        }
      }
    );

    if (!convResponse.data.conversations || convResponse.data.conversations.length === 0) {
      console.log(`⚠️ No conversation found for contact`);
      return [];
    }

    const conversationId = convResponse.data.conversations[0].id;
    console.log(`✅ Found conversation ID: ${conversationId}`);

    // Get messages (last 20)
    const messagesResponse = await axios.get(
      `https://services.leadconnectorhq.com/conversations/${conversationId}/messages`,
      {
        params: {
          limit: 20,
          type: 'TYPE_SMS'
        },
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28'
        }
      }
    );

  // Handle GHL returning object instead of array
    let messages = [];
    
    if (messagesResponse.data.messages) {
      if (Array.isArray(messagesResponse.data.messages)) {
        messages = messagesResponse.data.messages;
      } else if (typeof messagesResponse.data.messages === 'object') {
        messages = Object.values(messagesResponse.data.messages);
      }
    }
    
    console.log(`✅ Fetched ${messages.length} messages from conversation`);
    
    if (messages.length === 0) {
      return [];
    }
    
    // Format messages (oldest first)
    const formattedHistory = messages
      .reverse()
      .map(msg => {
        const direction = msg.direction === 'inbound' ? 'Contact' : 'You';
        return `${direction}: "${msg.body}"`;
      });

    console.log(`✅ Formatted ${formattedHistory.length} messages from history`);
    return formattedHistory;

  } catch (error) {
    console.error('❌ Error fetching conversation history:', error.message);
    return [];
  }
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

    // Check for stop tags
    const hasStopTag = client.stop_tags.some(tag => contactTags.includes(tag));
    
    if (hasStopTag) {
      return { shouldRespond: false, reason: 'Has stop tag' };
    }

    return { shouldRespond: true };

  } catch (error) {
    console.error('Error checking contact:', error.message);
    return { shouldRespond: false, reason: 'Error checking contact' };
  }
}

// Helper: Create GHL Task
async function createGHLTask(contact_id, action, GHL_API_KEY) {
  let dueDate = new Date();
  
  if (action.call_time) {
    const timeMatch = action.call_time.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2] || '0');
      const meridiem = timeMatch[3].toLowerCase();
      
      if (meridiem === 'pm' && hours !== 12) hours += 12;
      if (meridiem === 'am' && hours === 12) hours = 0;
      
      dueDate.setHours(hours, minutes, 0, 0);
    }
  }
  
  if (action.due_days) {
    dueDate.setDate(dueDate.getDate() + action.due_days);
  }
  
  try {
    await axios.post(
      `https://services.leadconnectorhq.com/contacts/${contact_id}/tasks`,
      {
        title: action.title,
        body: action.notes || '',
        dueDate: dueDate.toISOString(),
        completed: false,
        assignedTo: null,
        reminderTime: new Date(dueDate.getTime() - 15 * 60 * 1000).toISOString()
      },
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        }
      }
    );
    console.log(`✅ Created task: ${action.title} due at ${dueDate.toLocaleString()}`);
    return true;
  } catch (error) {
    console.error('❌ Error creating task:', error.response?.data || error.message);
    return false;
  }
}

// Helper: Book GHL Appointment
async function bookGHLAppointment(contact_id, contact_email, action, GHL_API_KEY) {
  if (!contact_email) {
    console.log('⚠️ No email - cannot book appointment');
    return false;
  }
  
  const CALENDAR_ID = 'tpf55lDwQzdwFZ9IExaB';
  const startTime = action.start_time 
    ? new Date(action.start_time) 
    : new Date(Date.now() + 24 * 60 * 60 * 1000);
  const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);
  
  try {
    await axios.post(
      'https://services.leadconnectorhq.com/calendars/events/appointments',
      {
        calendarId: CALENDAR_ID,
        contactId: contact_id,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        title: action.title || 'Call',
        appointmentStatus: 'confirmed',
        notes: action.notes || ''
      },
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        }
      }
    );
    console.log(`✅ Booked appointment: ${action.title}`);
    return true;
  } catch (error) {
    console.error('❌ Error booking appointment:', error.response?.data || error.message);
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

// Helper: Execute Actions
async function executeActions(contact_id, contact_email, actions, GHL_API_KEY) {
  if (!actions || actions.length === 0) return;
  
  console.log(`🎬 Executing ${actions.length} action(s)...`);
  
  let appointmentBooked = false;
  
  for (const action of actions) {
    switch (action.type) {
      case 'create_task':
        const taskCreated = await createGHLTask(contact_id, action, GHL_API_KEY);
        if (taskCreated) appointmentBooked = true;
        break;
      case 'book_appointment':
        const apptCreated = await bookGHLAppointment(contact_id, contact_email, action, GHL_API_KEY);
        if (apptCreated) appointmentBooked = true;
        break;
      case 'add_note':
        await addGHLNote(contact_id, action.notes, GHL_API_KEY);
        break;
      default:
        console.log(`⚠️ Unknown action type: ${action.type}`);
    }
  }
  
  // Add appointment_booked tag if task or appointment was created
  if (appointmentBooked) {
    try {
      await axios.post(
        `https://services.leadconnectorhq.com/contacts/${contact_id}/tags`,
        { tags: ['appointment_booked'] },
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          }
        }
      );
      console.log(`✅ Added "appointment_booked" tag`);
    } catch (error) {
      console.error('❌ Error adding appointment_booked tag:', error.message);
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
  const KNOWLEDGE_BASE = KNOWLEDGE_BASES[client_id];
  
  console.log(`🏢 Client: ${client.name}`);
  console.log(`👤 From: ${contact_name} (${contact_id})`);
  console.log(`📱 Phone: ${phone}`);
  console.log(`💬 Message: "${message_body}"`);
  
  // Respond immediately to prevent GHL timeout
  res.json({ success: true, message: 'Processing' });
  
  // Process async
  (async () => {
    try {
      // Check if should respond
      const check = await shouldRespond(contact_id, client, GHL_API_KEY);
      
      if (!check.shouldRespond) {
        console.log(`❌ Not responding: ${check.reason}`);
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

KNOWLEDGE BASE:
${KNOWLEDGE_BASE}

CONTACT INFO:
- Name: ${contact_name}
- Phone: ${phone}
- Property: ${property_address || 'Not provided'}
${historyString}
CRITICAL RULES:
1. ALWAYS READ THE CONVERSATION HISTORY ABOVE before responding
2. NEVER restart a conversation if there is existing history
3. If their message seems random or confusing, CHECK THE HISTORY to see if they're answering a previous question
4. If you cannot understand what they mean even with history, add tag "speak_now" to alert the team
5. NEVER use dashes (-), semicolons (;), or em dashes (—) in your messages
6. Sound like a human texting casually - not a grammar bot
7. Keep response under 160 characters when possible
8. Use casual language: "Yeah" not "Yes", "I get it" not "I understand"
9. Reference their name naturally in conversation

RESPONSE FORMAT (JSON ONLY):
{
  "message": "Your SMS response here",
  "tag": "answered_yes|answered_no|wrong_number|spam_troll|neutral_response|speak_now",
  "stop_bot": false,
  "actions": [] // Optional - include when booking calls/appointments
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
          tag: 'neutral_response',
          stop_bot: false
        };
      }

      console.log(`📋 Parsed response:`, JSON.stringify(responseData, null, 2));

      // Check for stop request
      if (responseData.stop_bot) {
        console.log('🛑 Contact requested stop');
        await axios.post(
          `https://services.leadconnectorhq.com/contacts/${contact_id}/tags`,
          { tags: ['stop_bot'] },
          {
            headers: {
              'Authorization': `Bearer ${GHL_API_KEY}`,
              'Content-Type': 'application/json',
              'Version': '2021-07-28'
            }
          }
        );
        console.log('✅ Added stop_bot tag, not sending response');
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
        
        await executeActions(contact_id, contactEmail, responseData.actions, GHL_API_KEY);
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
  const kbSizes = Object.entries(KNOWLEDGE_BASES).map(([id, kb]) => 
    `${id}: ${kb.length} chars`
  ).join(', ');
  
  res.json({ 
    status: 'Multi-Tenant SMS Bot - Running',
    version: '3.0.0-FINAL',
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
  console.log(`📋 Knowledge Bases Loaded:`);
  Object.entries(KNOWLEDGE_BASES).forEach(([id, kb]) => {
    console.log(`   - ${id}: ${kb.length} characters`);
  });
  console.log(`\n✅ Ready to receive webhooks!`);
  console.log(`${'='.repeat(60)}\n`);
});
