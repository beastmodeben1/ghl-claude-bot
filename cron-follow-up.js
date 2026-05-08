// cron-follow-up.js
// Runs once per day to check for ghosted leads and send follow-ups

const axios = require('axios');
const fs = require('fs');

// Load environment variables
const GHL_API_KEY = process.env.GHL_API_KEY;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// Load knowledge base
let KNOWLEDGE_BASE = '';
try {
  KNOWLEDGE_BASE = fs.readFileSync('./knowledge-base.txt', 'utf8');
} catch (e) {
  console.log('Warning: knowledge-base.txt not found.');
  KNOWLEDGE_BASE = 'You are a pre-foreclosure specialist.';
}

// Follow-up timing rules (in hours)
const FOLLOW_UP_TIMING = {
  follow_up_1: 24,   // 24 hours after initial interest
  follow_up_2: 72,   // 3 days total
  follow_up_3: 168   // 7 days total (last attempt)
};

// Helper: Get conversation phone number
async function getConversationPhone(contact_id) {
  try {
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

    if (convResponse.data.conversations && convResponse.data.conversations.length > 0) {
      return convResponse.data.conversations[0].lastMessageType === 'TYPE_SMS' 
        ? convResponse.data.conversations[0].contactInboxId 
        : null;
    }
    return null;
  } catch (error) {
    console.error('Error getting conversation phone:', error.message);
    return null;
  }
}

// Helper: Send follow-up SMS
async function sendFollowUpSMS(contact, followUpStage) {
  console.log(`📤 Sending ${followUpStage} to ${contact.name}...`);
  
  // Get conversation phone
  const conversationPhone = await getConversationPhone(contact.id);
  
  // Call Claude to generate follow-up message
  const claudeResponse = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: `You are a pre-foreclosure SMS bot sending a follow-up message.

KNOWLEDGE BASE:
${KNOWLEDGE_BASE}

CONTACT INFO:
- Name: ${contact.name}
- Phone: ${contact.phone}
- Follow-up stage: ${followUpStage}

FOLLOW-UP MESSAGE TEMPLATES:

Follow-up 1 (24 hours after initial interest):
"Hey [Name], just circling back. Did you get a chance to check out that video I sent over? Any questions about your options?"

Follow-up 2 (3 days after initial contact):
"[Name], I know you're probably busy dealing with everything. The auction is getting closer. Are you around to chat for a few minutes?"

Follow-up 3 (7 days - final attempt):
"Hey [Name], it's Peter. Haven't heard from ya... still looking for a way to get the bank off your back? This is my last reach out unless I hear back."

RESPONSE FORMAT (JSON ONLY):
{
  "message": "Your follow-up SMS here",
  "tag": "neutral_response",
  "stop_bot": false
}

Generate the appropriate follow-up message for ${followUpStage}. Keep it under 160 characters. Sound human and casual.`,
      messages: [
        {
          role: 'user',
          content: `Generate a ${followUpStage} message for ${contact.name}.`
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

  const responseText = claudeResponse.data.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  const responseData = JSON.parse(responseText.replace(/```json\n?|\n?```/g, '').trim());
  
  // Send SMS via GHL
  const smsPayload = {
    type: 'SMS',
    contactId: contact.id,
    message: responseData.message
  };
  
  if (conversationPhone) {
    smsPayload.conversationProviderId = conversationPhone;
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
  
  console.log(`✅ Sent ${followUpStage} to ${contact.name}: "${responseData.message}"`);
  
  // Update contact custom fields
  const newFollowUpCount = parseInt(followUpStage.replace('follow_up_', ''));
  
  await axios.put(
    `https://services.leadconnectorhq.com/contacts/${contact.id}`,
    {
      customFields: {
        follow_up_count: newFollowUpCount.toString(),
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
  
  // If this was follow_up_3 (final attempt), tag as "ghosted"
  if (followUpStage === 'follow_up_3') {
    await axios.post(
      `https://services.leadconnectorhq.com/contacts/${contact.id}/tags`,
      { tags: ['ghosted_final'] },
      {
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        }
      }
    );
    console.log(`🏷️ Tagged ${contact.name} as "ghosted_final"`);
  }
}

// Main function: Check for ghosted contacts and send follow-ups
async function checkGhostedContacts() {
  console.log('🔍 Checking for ghosted contacts needing follow-up...');
  console.log(`⏰ Current time: ${new Date().toISOString()}`);
  
  try {
    // Get contacts tagged "answered_yes" but not "ghosted_final" or "stop" tags
    const response = await axios.get(
      'https://services.leadconnectorhq.com/contacts',
      {
        params: {
          limit: 100
        },
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28'
        }
      }
    );
    
    const allContacts = response.data.contacts || [];
    
    // Filter to only those with "answered_yes" tag and no stop tags
    const contacts = allContacts.filter(c => {
      const tags = c.tags || [];
      return tags.includes('answered_yes') && 
             !tags.includes('ghosted_final') &&
             !tags.includes('stop_bot') &&
             !tags.includes('dnd') &&
             !tags.includes('do not contact');
    });
    
    console.log(`📊 Found ${contacts.length} contacts with "answered_yes" tag (out of ${allContacts.length} total)`);
    
    let followUpsSent = 0;
    
    for (const contact of contacts) {
      try {
        // Get last message timestamp
        const lastBotMessage = contact.customFields?.last_bot_message;
        const followUpCount = parseInt(contact.customFields?.follow_up_count || '0');
        
        if (!lastBotMessage) {
          console.log(`⚠️ ${contact.name}: No last_bot_message timestamp, skipping`);
          continue;
        }
        
        const lastMessageTime = new Date(lastBotMessage);
        const hoursSinceLastMessage = (Date.now() - lastMessageTime) / (1000 * 60 * 60);
        
        console.log(`📝 ${contact.name}: ${hoursSinceLastMessage.toFixed(1)} hours since last message, follow_up_count: ${followUpCount}`);
        
        // Determine if follow-up needed
        let followUpStage = null;
        
        if (followUpCount === 0 && hoursSinceLastMessage >= FOLLOW_UP_TIMING.follow_up_1) {
          followUpStage = 'follow_up_1';
        } else if (followUpCount === 1 && hoursSinceLastMessage >= FOLLOW_UP_TIMING.follow_up_2) {
          followUpStage = 'follow_up_2';
        } else if (followUpCount === 2 && hoursSinceLastMessage >= FOLLOW_UP_TIMING.follow_up_3) {
          followUpStage = 'follow_up_3';
        }
        
        if (followUpStage) {
          await sendFollowUpSMS(contact, followUpStage);
          followUpsSent++;
          
          // Small delay between sends to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
      } catch (error) {
        console.error(`❌ Error processing ${contact.name}:`, error.message);
      }
    }
    
    console.log(`\n✅ Follow-up check complete!`);
    console.log(`📤 Total follow-ups sent: ${followUpsSent}`);
    console.log(`⏰ Next check: ${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()}`);
    
  } catch (error) {
    console.error('❌ Fatal error in checkGhostedContacts:', error.message);
    throw error;
  }
}

// Run the check
console.log('🚀 Starting daily follow-up cron job...');
checkGhostedContacts()
  .then(() => {
    console.log('👍 Cron job completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('💥 Cron job failed:', error);
    process.exit(1);
  });
