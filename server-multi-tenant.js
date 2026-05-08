// server-multi-tenant.js - COMPLETE VERSION
// Serves multiple GHL sub-accounts from one Render deployment

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
    follow_up_timing: {
      follow_up_1: 24,
      follow_up_2: 72,
      follow_up_3: 168
    },
    response_delay: {
      min: 5,
      max: 20
    }
  },
  'client1': {
    name: 'Client 1 Name',
    ghl_api_key: process.env.CLIENT1_GHL_API_KEY,
    knowledge_base_file: './knowledge-base-master.txt',
    bot_name: 'Sarah',
    company_name: 'ABC Realty',
    max_messages_per_day: 6,
    timezone: 'America/Chicago',
    follow_up_timing: {
      follow_up_1: 24,
      follow_up_2: 72,
      follow_up_3: 168
    },
    response_delay: {
      min: 5,
      max: 20
    }
  },
  'client2': {
    name: 'Client 2 Name',
    ghl_api_key: process.env.CLIENT2_GHL_API_KEY,
    knowledge_base_file: './knowledge-base-master.txt',
    bot_name: 'Mike',
    company_name: 'XYZ Investments',
    max_messages_per_day: 3,
    timezone: 'America/Chicago',
    follow_up_timing: {
      follow_up_1: 24,
      follow_up_2: 72,
      follow_up_3: 168
    },
    response_delay: {
      min: 10,
      max: 30
    }
  }
};

// Load knowledge bases
const KNOWLEDGE_BASES = {};
for (const [clientId, config] of Object.entries(CLIENTS)) {
  try {
    KNOWLEDGE_BASES[clientId] = fs.readFileSync(config.knowledge_base_file, 'utf8');
    console.log(`✅ Loaded knowledge base for ${config.name}`);
  } catch (e) {
    console.log(`⚠️ Knowledge base not found for ${clientId}, using default`);
    KNOWLEDGE_BASES[clientId] = 'You are a pre-foreclosure specialist.';
  }
}

// Helper: Random delay
function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

// Helper: Make message human
function makeMessageHuman(message) {
  if (!message) return message;
  let cleaned = message;
  cleaned = cleaned.replace(/\s*[-–—]\s*/g, ' ');
  cleaned = cleaned.replace(/\s*[;]\s*/g, ', ');
  cleaned = cleaned.replace(/\.{3,}/g, '');
  cleaned = cleaned.replace(/\s{2,}/g, ' ');
  return cleaned.trim();
}

// Helper: Get conversation phone
async function getConversationPhone(contact_id, GHL_API_KEY) {
  try {
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
      const conv = response.data.conversations[0];
      console.log(`✅ Found receiving phone: ${conv.contactInboxId || 'none'}`);
      return conv.contactInboxId || null;
    }
    return null;
  } catch (error) {
    console.error('❌ Error getting conversation phone:', error.message);
    return null;
  }
}

// Helper: Get conversation history
async function getConversationHistory(contact_id, GHL_API_KEY) {
  try {
    console.log(`📖 Fetching conversation history for contact: ${contact_id}`);
    
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
      console.log(`⚠️ No conversations found`);
      return [];
    }

    const conversationId = convResponse.data.conversations[0].id;
    console.log(`✅ Found conversation ID: ${conversationId}`);

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

    const messages = messagesResponse.data.messages || [];
    
    if (!Array.isArray(messages)) {
      console.log(`⚠️ Messages is not an array:`, typeof messages);
      return [];
    }
    
    const formattedHistory = messages
      .reverse()
      .map(msg => {
        const direction = msg.direction === 'inbound' ? 'Contact' : 'You';
        return `${direction}: "${msg.body}"`;
      });

    console.log(`✅ Formatted ${formattedHistory.length} messages from history`);
    return formattedHistory;
  } catch (error) {
    console.error(`❌ Error fetching conversation history:`, error.message);
    return [];
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
  
  try {
    await axios.post(
      'https://services.leadconnectorhq.com/calendars/events/appointments',
      {
        calendarId: 'custom-action-plan-calendar-id',
        contactId: contact_id,
        startTime: action.start_time,
        title: action.title,
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
async function addGHLNote(contact_id, note, GHL_API_KEY) {
  try {
    await axios.post(
      `https://services.leadconnectorhq.com/contacts/${contact_id}/notes`,
      { body: note },
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        }
      }
    );
    console.log(`✅ Added note`);
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

// MAIN WEBHOOK HANDLER
app.post('/webhook', async (req, res) => {
  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📨 NEW SMS RECEIVED`);
    console.log(`${'='.repeat(60)}`);
    
    const client_id = req.body.client_id || 'caruth';
    const contact_id = req.body.contact_id;
    const message_body = req.body.message_body;
    const contact_name = req.body.contact_name || 'there';
    const phone = req.body.phone;
    
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
    
    const receivingPhone = await getConversationPhone(contact_id, GHL_API_KEY);
    console.log(`📞 Will reply from: ${receivingPhone || 'default number'}`);
    
    const conversationHistory = await getConversationHistory(contact_id, GHL_API_KEY);
    
    const delay = getRandomDelay(client.response_delay.min, client.response_delay.max);
    console.log(`⏱️ Waiting ${delay / 1000}s before responding...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    console.log(`🤖 Calling Claude API...`);
    
    const systemPrompt = `You are ${client.bot_name} from ${client.company_name}.

${KNOWLEDGE_BASE}

CONVERSATION HISTORY:
${conversationHistory.length > 0 ? conversationHistory.join('\n') : 'No previous messages'}

CURRENT MESSAGE:
Contact: "${message_body}"

Generate your response following all rules in the knowledge base.`;

    const claudeResponse = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: `Respond to: "${message_body}"`
        }]
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
    
    const responseText = claudeResponse.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    console.log(`📝 Response content: '''${responseText}'''`);
    
    let responseData;
    try {
      const cleanedText = responseText.replace(/```json\n?|\n?```/g, '').trim();
      responseData = JSON.parse(cleanedText);
    } catch (error) {
      console.log(`⚠️ Not JSON, treating as plain text`);
      responseData = {
        message: responseText,
        tag: 'neutral_response',
        stop_bot: false
      };
    }

    console.log(`📋 Parsed response:`, JSON.stringify(responseData, null, 2));
    
    const finalMessage = makeMessageHuman(responseData.message);
    
    const smsPayload = {
      type: 'SMS',
      contactId: contact_id,
      message: finalMessage
    };
    
    if (receivingPhone) {
      smsPayload.conversationProviderId = receivingPhone;
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

    try {
      await axios.put(
        `https://services.leadconnectorhq.com/contacts/${contact_id}`,
        {
          customFields: {
            last_bot_message: new Date().toISOString()
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          }
        }
      );
      console.log(`📅 Updated last_bot_message timestamp`);
    } catch (error) {
      console.log(`⚠️ Could not update timestamp:`, error.message);
    }

    if (responseData.actions && responseData.actions.length > 0) {
      const contactEmail = null;
      await executeActions(contact_id, contactEmail, responseData.actions, GHL_API_KEY);
    }

    if (responseData.tag) {
      try {
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
        console.log(`✅ Added tag: ${responseData.tag}`);
      } catch (error) {
        console.log(`⚠️ Could not add tag:`, error.message);
      }
    }

    console.log(`✅ COMPLETE - Delay: ${delay/1000}s, Tag: ${responseData.tag || 'none'}, stop_bot: ${responseData.stop_bot}`);
    
    res.json({ success: true, client: client.name });
    
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/', (req, res) => {
  const clientCount = Object.keys(CLIENTS).length;
  res.json({ 
    status: 'Multi-Tenant SMS Bot - Running',
    clients: clientCount,
    version: '3.0.0'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Multi-tenant bot server running on port ${PORT}`);
  console.log(`👥 Serving ${Object.keys(CLIENTS).length} clients:`);
  Object.entries(CLIENTS).forEach(([id, config]) => {
    console.log(`   - ${id}: ${config.name}`);
  });
});
