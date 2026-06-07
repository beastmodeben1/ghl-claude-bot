// cron-follow-up.js - SOPHISTICATED VERSION
// Runs daily at 9am to check for ghosted leads
// Different cadences per objection type, timezone aware, business hours only

const axios = require('axios');
const fs = require('fs');

const GHL_API_KEY = process.env.GHL_API_KEY || process.env.CARUTH_GHL_API_KEY;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// Load knowledge base
let KNOWLEDGE_BASE = '';
try {
  KNOWLEDGE_BASE = fs.readFileSync('./knowledge-base-master.txt', 'utf8');
} catch (e) {
  KNOWLEDGE_BASE = 'You are a pre-foreclosure specialist.';
}

// FOLLOW-UP CADENCES
const CADENCES = {
  'loan_mod': {
    name: 'Loan Modification',
    days: [2, 5, 7, 8, 9, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200],
    repeat_days: 20,
    max_attempts: 10
  },
  'bankruptcy': {
    name: 'Bankruptcy',
    days: [2, 5, 7, 8, 9, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200],
    repeat_days: 20,
    max_attempts: 20
  },
  'covered': {
    name: 'Got it Covered',
    days: [7, 10, 15, 20, 30, 60, 90, 120, 150, 180],
    repeat_days: 30,
    max_attempts: 10
  },
  'engaged': {
    name: 'Engaged but Ghosted',
    days: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
    repeat_days: 2,
    max_attempts: 15,
    special_message_3: true
  },
  'default': {
    name: 'Standard Follow-up',
    days: [1, 3, 7, 14, 30],
    repeat_days: 30,
    max_attempts: 10
  }
};

// Helper: Check if current time is within business hours
function isBusinessHours(timezone = 'America/Chicago') {
  const now = new Date();
  const options = { 
    timeZone: timezone, 
    hour: 'numeric', 
    hour12: false 
  };
  const hour = parseInt(now.toLocaleString('en-US', options));
  
  return hour >= 9 && hour <= 21; // 9am-9pm
}

// Helper: Get next follow-up day for cadence
function getNextFollowUpDay(cadence, attemptNumber) {
  const config = CADENCES[cadence] || CADENCES['default'];
  
  if (attemptNumber < config.days.length) {
    return config.days[attemptNumber];
  } else {
    // After schedule ends, repeat every X days
    const lastDay = config.days[config.days.length - 1];
    const additionalCycles = attemptNumber - config.days.length + 1;
    return lastDay + (additionalCycles * config.repeat_days);
  }
}

// Helper: Get conversation phone
async function getConversationPhone(contact_id) {
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
      return response.data.conversations[0].contactInboxId || null;
    }
    return null;
  } catch (error) {
    return null;
  }
}

// Helper: Send follow-up message
async function sendFollowUp(contact, attemptNumber, cadence) {
  console.log(`📤 Sending follow-up #${attemptNumber} (${cadence}) to ${contact.name}...`);
  
  const conversationPhone = await getConversationPhone(contact.id);
  
  // Determine if this is the special 3rd message for engaged leads
  const isSpecialMessage = (cadence === 'engaged' && attemptNumber === 3);
  
  // Build prompt for Claude
  const systemPrompt = `You are Peter from Caruth Brothers, following up with a lead who ghosted.

CONTACT INFO:
- Name: ${contact.name}
- Cadence: ${cadence}
- Attempt: ${attemptNumber}
${isSpecialMessage ? '\n⚠️ THIS IS THE 3RD ATTEMPT - Use the "Did we offend you?" message\n' : ''}

FOLLOW-UP MESSAGE RULES:
1. NO "just circling back" or "touching base" - sounds like a bot
2. Start with their name or jump straight to the question
3. Keep it natural and casual
4. Reference their specific situation if known

MESSAGE TEMPLATES BY CADENCE:

Loan Modification:
- Attempt 1: "${contact.name}, how's the loan mod process going? Have they given you a decision yet?"
- Attempt 2: "${contact.name}, just wanted to check in. Did the loan mod go through?"
- Attempt 3+: "${contact.name}, any update on the modification? Still waiting to hear back from the bank?"

Bankruptcy:
- Attempt 1: "${contact.name}, how did the bankruptcy filing go?"
- Attempt 2: "${contact.name}, has the bankruptcy been processed yet?"
- Attempt 3+: "${contact.name}, checking in on the bankruptcy. Everything go through okay?"

Got it Covered:
- Attempt 1: "${contact.name}, just checking in. Did everything work out with the house?"
- Attempt 2: "${contact.name}, wanted to see if you still need any help with your situation."
- Attempt 3+: "${contact.name}, how are things going with the property?"

Engaged but Ghosted:
${isSpecialMessage ? 
  `- Attempt 3 (SPECIAL): "${contact.name}, did we do something to offend you? We were just trying to help."` :
  `- Attempt 1-2: "${contact.name}, are you still interested in discussing your options?"
- Attempt 4+: "${contact.name}, just wanted to follow up. Still need help with the foreclosure?"`
}

Generate a natural follow-up message. Keep under 160 characters. Sound human.

RESPONSE FORMAT (JSON):
{
  "message": "Your follow-up message here"
}`;

  try {
    const claudeResponse = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: `Generate follow-up #${attemptNumber} for ${cadence} cadence.`
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

    const responseText = claudeResponse.data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const responseData = JSON.parse(responseText.replace(/```json\n?|\n?```/g, '').trim());
    
    // Send SMS
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
    
    console.log(`✅ Sent: "${responseData.message}"`);
    
    // Update custom fields
    await axios.put(
      `https://services.leadconnectorhq.com/contacts/${contact.id}`,
      {
        customFields: {
          follow_up_count: attemptNumber.toString(),
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
    
    return true;
  } catch (error) {
    console.error(`❌ Error sending follow-up:`, error.message);
    return false;
  }
}

// Main function
async function checkFollowUps() {
  console.log('🔍 Checking for ghosted contacts...');
  console.log(`⏰ ${new Date().toISOString()}`);
  
  // Check if within business hours
  if (!isBusinessHours()) {
    console.log('⚠️ Outside business hours (9am-9pm). Exiting.');
    return;
  }
  
  try {
    // Get all contacts with answered_yes tag
    const response = await axios.get(
      'https://services.leadconnectorhq.com/contacts',
      {
        params: { limit: 100 },
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28'
        }
      }
    );
    
    const allContacts = response.data.contacts || [];
    
    // Filter: has answered_yes, no stop tags, not appointment_booked type
    const contacts = allContacts.filter(c => {
      const tags = c.tags || [];
      const lastMessageType = c.customFields?.last_message_type || '';
      
      return tags.includes('answered_yes') && 
             !tags.includes('stop_bot') &&
             !tags.includes('dnd') &&
             !tags.includes('do not contact') &&
             !tags.includes('ghosted_final') &&
             lastMessageType !== 'appointment_booked' &&
             lastMessageType !== 'ended';
    });
    
    console.log(`📊 Found ${contacts.length} potential follow-up contacts`);
    
    let sent = 0;
    
    for (const contact of contacts) {
      try {
        const lastBotMessage = contact.customFields?.last_bot_message;
        const followUpCount = parseInt(contact.customFields?.follow_up_count || '0');
        let cadenceType = contact.customFields?.follow_up_cadence || 'default';
        
        // Auto-detect cadence from tags if not set
        const tags = contact.tags || [];
        if (!cadenceType || cadenceType === 'default') {
          if (tags.includes('objection_loan_mod')) cadenceType = 'loan_mod';
          else if (tags.includes('objection_bankruptcy')) cadenceType = 'bankruptcy';
          else if (tags.includes('objection_covered')) cadenceType = 'covered';
          else if (tags.includes('engaged_ghosted')) cadenceType = 'engaged';
        }
        
        if (!lastBotMessage) {
          console.log(`⚠️ ${contact.name}: No timestamp, skipping`);
          continue;
        }
        
        // Calculate days since last message
        const lastMessage = new Date(lastBotMessage);
        const daysSince = (Date.now() - lastMessage) / (1000 * 60 * 60 * 24);
        
        // Get next follow-up day for this cadence
        const nextDay = getNextFollowUpDay(cadenceType, followUpCount);
        const cadenceConfig = CADENCES[cadenceType] || CADENCES['default'];
        
        console.log(`📝 ${contact.name}: ${daysSince.toFixed(1)} days, cadence: ${cadenceType}, attempt: ${followUpCount}, next: ${nextDay} days`);
        
        // Check if it's time for next follow-up
        if (daysSince >= nextDay && followUpCount < cadenceConfig.max_attempts) {
          await sendFollowUp(contact, followUpCount + 1, cadenceType);
          sent++;
          await new Promise(r => setTimeout(r, 2000)); // Delay between sends
        }
        
      } catch (error) {
        console.error(`❌ Error processing ${contact.name}:`, error.message);
      }
    }
    
    console.log(`\n✅ Follow-up check complete!`);
    console.log(`📤 Sent: ${sent} messages`);
    
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    throw error;
  }
}

// Run
console.log('🚀 Starting follow-up cron...');
checkFollowUps()
  .then(() => {
    console.log('👍 Complete');
    process.exit(0);
  })
  .catch(error => {
    console.error('💥 Failed:', error);
    process.exit(1);
  });
