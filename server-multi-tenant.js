// server-multi-tenant.js
// Serves multiple GHL sub-accounts from one Render deployment

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const app = express();

app.use(express.json());

// CLIENT CONFIGURATIONS
// Add each client here with their API keys and settings
const CLIENTS = {
  'caruth': {
    name: 'Caruth Brothers',
    ghl_api_key: process.env.CARUTH_GHL_API_KEY,
    knowledge_base_file: './knowledge-base-caruth.txt',
    bot_name: 'Peter',
    company_name: 'Caruth Brothers',
    max_messages_per_day: 6,
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
    knowledge_base_file: './knowledge-base-master.txt',  // Uses template
    bot_name: 'Sarah',  // Their rep's name
    company_name: 'ABC Realty',
    max_messages_per_day: 6,
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
    knowledge_base_file: './knowledge-base-master.txt',  // Uses template
    bot_name: 'Mike',
    company_name: 'XYZ Investments',
    max_messages_per_day: 3,  // Conservative
    follow_up_timing: {
      follow_up_1: 24,
      follow_up_2: 72,
      follow_up_3: 168
    },
    response_delay: {
      min: 10,  // Slower, more human
      max: 30
    }
  }
  // Add more clients as needed
};

// Shared Claude API key (one key for all clients)
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

// Load knowledge bases for each client
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

// Business rules
const RULES = {
  response_delay_min: 5,
  response_delay_max: 20,
  stop_tags: ['stop_bot', 'dnd', 'manual_takeover', 'do_not_contact'],
  max_messages_per_day: 3,
  message_max_length: 160
};

// Helper: Random delay
function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

// Helper: Make message sound human
function makeMessageHuman(message) {
  if (!message) return message;
  let cleaned = message;
  cleaned = cleaned.replace(/\s*[-–—]\s*/g, ' ');
  cleaned = cleaned.replace(/\s*[;]\s*/g, ', ');
  return cleaned;
}

// MAIN WEBHOOK HANDLER
app.post('/webhook', async (req, res) => {
  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📨 NEW SMS RECEIVED`);
    console.log(`${'='.repeat(60)}`);
    
    // Extract client_id from webhook payload
    const client_id = req.body.client_id || 'caruth'; // Default to caruth for backward compatibility
    const contact_id = req.body.contact_id;
    const message_body = req.body.message_body;
    const contact_name = req.body.contact_name || 'there';
    const phone = req.body.phone;
    
    console.log(`🏢 Client: ${CLIENTS[client_id]?.name || 'Unknown'}`);
    console.log(`👤 From: ${contact_name} (${contact_id})`);
    console.log(`📱 Phone: ${phone}`);
    console.log(`💬 Message: "${message_body}"`);
    
    // Validate client exists
    if (!CLIENTS[client_id]) {
      console.log(`❌ Unknown client_id: ${client_id}`);
      return res.status(400).json({ error: 'Unknown client_id' });
    }
    
    // Get client-specific config
    const GHL_API_KEY = CLIENTS[client_id].ghl_api_key;
    const KNOWLEDGE_BASE = KNOWLEDGE_BASES[client_id];
    
    // Rest of the bot logic here (same as before, but using client-specific GHL_API_KEY and KNOWLEDGE_BASE)
    // ... [full bot logic] ...
    
    res.json({ success: true, client: CLIENTS[client_id].name });
    
  } catch (error) {
    console.error('❌ Error:', error);
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
