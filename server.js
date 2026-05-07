const express = require('express');
const axios = require('axios');
const fs = require('fs');
const app = express();

app.use(express.json());

// Load environment variables
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const GHL_API_KEY = process.env.GHL_API_KEY;
const STREAMLINED_API_KEY = process.env.STREAMLINED_API_KEY;

// Load knowledge base from file
let KNOWLEDGE_BASE = '';
try {
  KNOWLEDGE_BASE = fs.readFileSync('./knowledge-base.txt', 'utf8');
} catch (e) {
  console.log('Warning: knowledge-base.txt not found. Using default.');
  KNOWLEDGE_BASE = 'You are a pre-foreclosure specialist helping distressed homeowners.';
}

// Business rules (updated based on 400+ conversation analysis)
const RULES = {
  response_delay_min: 5,   // seconds (was 10 - feels more natural)
  response_delay_max: 20,  // seconds (was 45 - faster response)
  stop_tags: ['stop_bot', 'dnd', 'manual_takeover', 'do_not_contact'],
  max_messages_per_day: 3, // Conservative default (was 10)
  message_max_length: 160, // SMS character limit
  
  // Stop keywords that auto-trigger stop_bot
  stop_keywords: [
    'stop', 'unsubscribe', 'remove me', 'dont contact', 'stop texting',
    'cease and desist', 'lawyer', 'harassment', 'wrong number',
    'already sold', 'not in foreclosure', 'caught up', 'refinanced'
  ]
};

// Helper: Random delay
function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

// Helper: Make message sound human (remove robotic punctuation)
function makeMessageHuman(message) {
  if (!message) return message;
  
  let cleaned = message;
  
  // Remove dashes used as separators (but keep phone numbers with dashes)
  // Pattern: word - word OR word- word OR word -word
  cleaned = cleaned.replace(/(\w+)\s*-\s+(\w+)/g, '$1 $2');
  
  // Remove semicolons (nobody texts with semicolons!)
  cleaned = cleaned.replace(/;/g, ',');
  
  // Remove em dashes and en dashes
  cleaned = cleaned.replace(/—/g, ' ');
  cleaned = cleaned.replace(/–/g, ' ');
  
  // Remove excessive ellipses (... → just remove or replace with period)
  cleaned = cleaned.replace(/\.{3,}/g, '');
  
  // Clean up any double spaces created
  cleaned = cleaned.replace(/\s{2,}/g, ' ');
  
  // Replace overly formal phrases with casual ones
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

// Helper: Get conversation phone number from GHL
async function getConversationPhone(contact_id) {
  try {
    console.log(`🔍 Looking up conversation for contact: ${contact_id}`);
    
    // Get conversations for this contact
    const response = await axios.get(
      `https://services.leadconnectorhq.com/conversations/search`,
      {
        params: {
          contactId: contact_id
        },
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28'
        }
      }
    );

    if (response.data.conversations && response.data.conversations.length > 0) {
      // Get the most recent conversation
      const conversation = response.data.conversations[0];
      
      // The phone number might be in different fields depending on GHL version
      const phone = conversation.locationPhone || 
                   conversation.phone || 
                   conversation.businessPhone ||
                   null;
      
      if (phone) {
        console.log(`✅ Found receiving phone: ${phone}`);
        return phone;
      } else {
        console.log(`⚠️ Conversation found but no phone number in data:`, JSON.stringify(conversation, null, 2));
        return null;
      }
    } else {
      console.log(`⚠️ No conversations found for contact ${contact_id}`);
      return null;
    }
  } catch (error) {
    console.error('❌ Error getting conversation phone:', error.response?.data || error.message);
    return null;
  }
}

// Helper: Get conversation history (last 20 messages)
async function getConversationHistory(contact_id) {
  try {
    console.log(`📜 Fetching conversation history for contact: ${contact_id}`);
    
    // First get the conversation ID
    const convResponse = await axios.get(
      `https://services.leadconnectorhq.com/conversations/search`,
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

    // Get messages from this conversation (last 20)
    const messagesResponse = await axios.get(
      `https://services.leadconnectorhq.com/conversations/${conversationId}/messages`,
      {
        params: {
          limit: 20,
          type: 'SMS'
        },
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28'
        }
      }
    );

    const messages = messagesResponse.data.messages || [];
    
    // Format messages in chronological order (oldest first)
    const formattedHistory = messages
      .reverse() // GHL returns newest first, we want oldest first
      .map(msg => {
        const direction = msg.direction === 'inbound' ? 'Contact' : 'You';
        return `${direction}: "${msg.body}"`;
      });

    console.log(`✅ Fetched ${formattedHistory.length} messages from history`);
    return formattedHistory;

  } catch (error) {
    console.error('❌ Error fetching conversation history:', error.response?.data || error.message);
    return [];
  }
}

// Helper: Check if should respond
async function shouldRespond(contact_id) {
  try {
    // Get contact data from GHL
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

    // Check if contact has stop tags
    const hasStopTag = RULES.stop_tags.some(tag => contactTags.includes(tag));
    
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
async function createGHLTask(contact_id, action) {
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + (action.due_days || 0));
  
  try {
    await axios.post(
      `https://services.leadconnectorhq.com/contacts/${contact_id}/tasks`,
      {
        title: action.title,
        body: action.notes || '',
        dueDate: dueDate.toISOString(),
        completed: false
      },
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        }
      }
    );
    console.log(`✅ Created task: ${action.title}`);
    return true;
  } catch (error) {
    console.error('❌ Error creating task:', error.response?.data || error.message);
    return false;
  }
}

// Helper: Book GHL Appointment
async function bookGHLAppointment(contact_id, contact_email, action) {
  // Custom Action Plan calendar ID
  const CALENDAR_ID = 'tpf55lDwQzdwFZ9IExaB';
  
  // Parse appointment time (default to tomorrow 2pm if not specified)
  const startTime = action.start_time 
    ? new Date(action.start_time) 
    : new Date(Date.now() + 24 * 60 * 60 * 1000); // Tomorrow
  
  const endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // 30 min call
  
  try {
    await axios.post(
      'https://services.leadconnectorhq.com/calendars/events/appointments',
      {
        calendarId: CALENDAR_ID,
        contactId: contact_id,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        title: action.title || 'Caruth Brothers Call',
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
async function addGHLNote(contact_id, notes) {
  try {
    await axios.post(
      `https://services.leadconnectorhq.com/contacts/${contact_id}/notes`,
      {
        body: notes
      },
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
    console.error('❌ Error adding note:', error.response?.data || error.message);
    return false;
  }
}

// Helper: Execute Actions
async function executeActions(contact_id, contact_email, actions) {
  if (!actions || actions.length === 0) return;
  
  console.log(`🎬 Executing ${actions.length} action(s)...`);
  
  for (const action of actions) {
    switch (action.type) {
      case 'create_task':
        await createGHLTask(contact_id, action);
        break;
      case 'book_appointment':
        await bookGHLAppointment(contact_id, contact_email, action);
        break;
      case 'add_note':
        await addGHLNote(contact_id, action.notes);
        break;
      case 'add_tag':
        // Tag handled via main tagging system
        console.log(`📌 Additional tag: ${action.tag}`);
        break;
      default:
        console.log(`⚠️ Unknown action type: ${action.type}`);
    }
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Claude SMS Bot - Running',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    features: ['conversation_history', 'objection_handling', 'actions_framework']
  });
});

// Main webhook endpoint
app.post('/webhook/:clientId', async (req, res) => {
  const { clientId } = req.params;
  
  console.log(`\n=== NEW SMS RECEIVED ===`);
  console.log(`Client ID: ${clientId}`);
  console.log(`Time: ${new Date().toISOString()}`);

  const {
    contact_id,
    contact_name,
    message_body,
    phone,
    property_address
  } = req.body;

  console.log(`From: ${contact_name} (${contact_id})`);
  console.log(`Message: "${message_body}"`);
  console.log(`📞 DEBUG - Full webhook payload:`, JSON.stringify(req.body, null, 2));

  // Respond immediately to GHL (prevents timeout)
  res.json({ 
    success: true, 
    message: 'Processing' 
  });

  // Process async
  (async () => {
    try {
      // RULE: Check if should respond
      const check = await shouldRespond(contact_id);
      
      if (!check.shouldRespond) {
        console.log(`❌ Not responding: ${check.reason}`);
        return;
      }

      // GET CONVERSATION PHONE NUMBER
      const conversationPhone = await getConversationPhone(contact_id);
      
      if (!conversationPhone) {
        console.log(`⚠️ Could not determine receiving phone number - using default SMS send`);
      } else {
        console.log(`✅ Will reply from: ${conversationPhone}`);
      }

      // GET CONVERSATION HISTORY (CRITICAL - never restart conversations!)
      const conversationHistory = await getConversationHistory(contact_id);

      // RULE: Random delay 5-20 seconds
      const delay = getRandomDelay(RULES.response_delay_min, RULES.response_delay_max);
      console.log(`⏳ Waiting ${delay/1000}s before responding...`);
      await new Promise(resolve => setTimeout(resolve, delay));

      console.log(`🤖 Calling Claude API...`);

      // Build conversation history string
      const historyString = conversationHistory.length > 0
        ? `\n\nCONVERSATION HISTORY (from oldest to newest):\n${conversationHistory.join('\n')}\n`
        : '\n\n(No previous conversation history - this is first contact)\n';

      // Call Claude API
      const claudeResponse = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          system: `You are a pre-foreclosure SMS bot.

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
9. Imperfect grammar is GOOD - it sounds human
10. Be conversational and empathetic
11. Reference their name naturally in conversation

RESPONSE FORMAT (JSON ONLY):
{
  "message": "Your SMS response here",
  "tag": "answered_yes|answered_no|wrong_number|spam_troll|neutral_response|speak_now",
  "stop_bot": false
}

Tags explained:
- answered_yes: They want the video/info/help
- answered_no: Clear rejection
- wrong_number: Not the homeowner
- spam_troll: Abusive/spam
- neutral_response: Questions, vague responses
- speak_now: Message is confusing and you need human help to interpret it
- stop_bot: They want to stop (use stop_bot: true)

Set stop_bot to true if they say: stop, unsubscribe, remove me, don't contact

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

      // Extract response text
      const responseContent = claudeResponse.data.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      console.log(`Response content: ${responseContent}`);

      // Parse JSON response
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

      console.log(`Parsed response:`, responseData);

      // If contact wants to stop, add tag and exit
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

      // IMPORTANT: Clean message to sound human (remove dashes, semicolons, etc.)
      const originalMessage = responseData.message;
      responseData.message = makeMessageHuman(responseData.message);
      
      if (originalMessage !== responseData.message) {
        console.log(`🧹 Cleaned message: "${originalMessage}" → "${responseData.message}"`);
      }

      // Send SMS response
      console.log(`📱 Sending SMS: "${responseData.message}"`);
      
      const smsPayload = {
        type: 'SMS',
        contactId: contact_id,
        message: responseData.message
      };

      // Add 'from' field if we found the conversation phone
      if (conversationPhone) {
        smsPayload.from = conversationPhone;
        console.log(`📞 Replying from: ${conversationPhone}`);
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

      // Execute actions if any (tasks, appointments, notes)
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
        
        await executeActions(contact_id, contactEmail, responseData.actions);
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

      console.log(`✅ COMPLETE - Delay: ${delay/1000}s, Tag: ${responseData.tag}`);
      console.log(`========================\n`);

    } catch (error) {
      console.error('❌ ERROR:', error.response?.data || error.message);
      console.log(`========================\n`);
    }
  })();
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Claude SMS Bot Running`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`📋 Knowledge Base: ${KNOWLEDGE_BASE.length} characters loaded`);
  console.log(`⏱️  Response Delay: ${RULES.response_delay_min}-${RULES.response_delay_max}s`);
  console.log(`🛑 Stop Tags: ${RULES.stop_tags.join(', ')}`);
  console.log(`\n✅ Ready to receive webhooks!\n`);
});
