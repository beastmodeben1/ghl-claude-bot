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

// Business rules
const RULES = {
  response_delay_min: 10,  // seconds
  response_delay_max: 45,  // seconds
  stop_tags: ['stop_bot', 'dnd', 'manual_takeover', 'do_not_contact'],
  max_messages_per_day: 10
};

// Helper: Random delay
function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
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

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Claude SMS Bot - Running',
    version: '1.0.0',
    timestamp: new Date().toISOString()
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

      // RULE: Random delay 10-45 seconds
      const delay = getRandomDelay(RULES.response_delay_min, RULES.response_delay_max);
      console.log(`⏳ Waiting ${delay/1000}s before responding...`);
      await new Promise(resolve => setTimeout(resolve, delay));

      console.log(`🤖 Calling Claude API...`);

      // Call Claude API with Streamlined MCP
      const claudeResponse = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          system: `You are a pre-foreclosure SMS bot with access to Streamlined CRM data.

KNOWLEDGE BASE:
${KNOWLEDGE_BASE}

CONTACT INFO:
- Name: ${contact_name}
- Phone: ${phone}
- Property: ${property_address || 'Not provided'}
- Contact ID: ${contact_id}

INSTRUCTIONS:
1. Use Streamlined execute_query to get conversation history for this contact
2. Query: SELECT message_body, direction, created_at FROM conversations_messages WHERE contact_id = '${contact_id}' ORDER BY created_at DESC LIMIT 10
3. Read the full conversation context
4. Respond according to knowledge base
5. Keep response under 160 characters when possible
6. Determine intent from their message

RESPONSE FORMAT (JSON):
{
  "message": "Your SMS response here",
  "tag": "answered_yes|answered_no|wrong_number|spam_troll|neutral_response",
  "stop_bot": false
}

Set stop_bot to true if they say: stop, unsubscribe, remove me, don't contact`,
          messages: [
            {
              role: 'user',
              content: `Latest message from contact: "${message_body}"\n\nUse Streamlined MCP to fetch conversation history, then respond appropriately.`
            }
          ],
          mcp_servers: [
            {
              type: 'url',
              url: 'https://gateway.streamlined.so/query/mcp',
              name: 'streamlined-mcp'
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

      // Send SMS response
      console.log(`📱 Sending SMS: "${responseData.message}"`);
      await axios.post(
        'https://services.leadconnectorhq.com/conversations/messages',
        {
          type: 'SMS',
          contactId: contact_id,
          message: responseData.message
        },
        {
          headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          }
        }
      );

      console.log(`✅ SMS sent successfully`);

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
