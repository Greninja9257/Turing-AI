const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json({ limit: '50mb' }));

// CORS middleware - allow requests from anywhere (needed for trainer.html)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

app.use(express.static('public'));

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// In-memory storage with file persistence
let globalMemory = {
  patterns: {},           // Pattern-based learning
  contextPairs: [],       // High-quality context-response pairs
  semanticClusters: {},   // Grouped similar concepts
  qualityScores: {},      // Track quality of learned content
  stats: {
    totalMessages: 0,
    totalConversations: 0,
    trainingDataPoints: 0,
    garbageFiltered: 0,
    liveConversationsLearned: 0
  }
};

// Store recent conversations for learning
const conversationBuffer = new Map(); // userId -> conversation history

// Track active sessions (sessions active in last 5 minutes)
const activeSessions = new Map(); // sessionId -> lastActivity timestamp

// Load memory from file on startup
const MEMORY_FILE = path.join(__dirname, 'data', 'memory.json');

async function loadMemory() {
  try {
    await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
    const data = await fs.readFile(MEMORY_FILE, 'utf8');
    globalMemory = JSON.parse(data);
    console.log('✓ Memory loaded from disk');
  } catch (error) {
    console.log('→ Starting with fresh memory');
  }
}

async function saveMemory() {
  try {
    await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
    await fs.writeFile(MEMORY_FILE, JSON.stringify(globalMemory, null, 2));
  } catch (error) {
    console.error('Failed to save memory:', error);
  }
}

// Text cleaning utility
class TextCleaner {
  static clean(text) {
    if (!text) return '';
    
    // Remove common conversation prefixes
    let cleaned = text.trim();
    
    // Remove patterns like "Human 1:", "Human 2:", "Person A:", "Speaker 1:", etc.
    cleaned = cleaned.replace(/^(Human|Person|Speaker|User|Assistant|AI|Bot)\s*[0-9]+\s*:\s*/i, '');
    cleaned = cleaned.replace(/^(Human|Person|Speaker|User|Assistant|AI|Bot)\s*[A-Z]\s*:\s*/i, '');
    
    // Remove just "Human:", "Person:", etc.
    cleaned = cleaned.replace(/^(Human|Person|Speaker|User|Assistant|AI|Bot)\s*:\s*/i, '');
    
    // Remove leading/trailing quotes that might be artifacts
    cleaned = cleaned.replace(/^["']|["']$/g, '');
    
    // Clean up extra whitespace
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    return cleaned;
  }
}

// Garbage classification system
class GarbageClassifier {
  static isGarbage(text) {
    const lower = text.toLowerCase().trim();
    
    // Too short or too long (more lenient now)
    if (lower.length < 1 || lower.length > 1000) return true;
    
    // Excessive special characters (more lenient)
    const specialCharRatio = (text.match(/[^a-zA-Z0-9\s.,!?'-]/g) || []).length / text.length;
    if (specialCharRatio > 0.5) return true; // Was 0.3, now 0.5
    
    // Spam patterns (keep strict for actual spam)
    const spamPatterns = [
      /click here/i,
      /buy now/i,
      /limited time/i,
      /act now/i,
      /free money/i,
      /\b(viagra|cialis|casino)\b/i,
      /http[s]?:\/\/[^\s]{30,}/i, // Very long URLs only (was 20, now 30)
      /(.)\1{8,}/, // Repeated characters (was 5, now 8 - allow some emphasis)
      /\d{6,}/, // Very long number sequences (was 4, now 6)
    ];
    
    if (spamPatterns.some(pattern => pattern.test(text))) return true;
    
    // Offensive/harmful content (keep strict)
    const harmfulPatterns = [
      /\b(kill yourself|kys)\b/i,
      /\b(n[i1]gg[ae]r|f[a4]gg[o0]t)\b/i,
    ];
    
    if (harmfulPatterns.some(pattern => pattern.test(text))) return true;
    
    // Too many uppercase words - SHOUTING (more lenient)
    const words = text.split(/\s+/);
    const upperWords = words.filter(w => w === w.toUpperCase() && w.length > 1);
    if (upperWords.length / words.length > 0.8) return true; // Was 0.5, now 0.8
    
    return false;
  }
  
  static calculateQuality(input, response) {
    let score = 50; // Base score
    
    // Length appropriateness (more lenient)
    const inputWords = input.split(/\s+/).length;
    const responseWords = response.split(/\s+/).length;
    
    if (responseWords >= 2 && responseWords <= 100) score += 20;
    if (inputWords >= 1 && inputWords <= 50) score += 15;
    
    // Has some substance (not just one-word replies like "k" or "ok")
    if (responseWords >= 3) score += 15;
    
    // Natural conversational quality
    if (!/^(ok|k|yeah|yep|nope)$/i.test(response)) score += 10;
    
    // Note: We don't penalize OR reward informal speech
    // Both "you" and "u" are equally valid
    // Both "thanks" and "thx" are equally valid
    // The AI can learn natural human conversation without bias
    
    return Math.max(0, Math.min(100, score));
  }
}

// Intelligent learning system
class IntelligentLearner {
  static extractKeywords(text) {
    // Remove common stop words
    const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 'who', 'when', 'where', 'why', 'how']);
    
    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
    
    return [...new Set(words)];
  }
  
  static learnPattern(input, response, quality) {
    const keywords = this.extractKeywords(input);
    
    // Create semantic clusters
    keywords.forEach(keyword => {
      if (!globalMemory.semanticClusters[keyword]) {
        globalMemory.semanticClusters[keyword] = [];
      }
      
      // Store with quality weighting
      globalMemory.semanticClusters[keyword].push({
        input: input.toLowerCase(),
        response,
        quality,
        timestamp: Date.now()
      });
      
      // Keep only top 20 highest quality responses per keyword
      globalMemory.semanticClusters[keyword].sort((a, b) => b.quality - a.quality);
      if (globalMemory.semanticClusters[keyword].length > 20) {
        globalMemory.semanticClusters[keyword] = globalMemory.semanticClusters[keyword].slice(0, 20);
      }
    });
    
    // Store high-quality pairs separately
    if (quality >= 60) {
      globalMemory.contextPairs.push({
        input: input.toLowerCase(),
        response,
        quality,
        timestamp: Date.now()
      });
      
      // Keep only top 1000 context pairs
      if (globalMemory.contextPairs.length > 1000) {
        globalMemory.contextPairs.sort((a, b) => b.quality - a.quality);
        globalMemory.contextPairs = globalMemory.contextPairs.slice(0, 1000);
      }
    }
  }
  
  static findBestResponse(input) {
    const keywords = this.extractKeywords(input);
    const inputLower = input.toLowerCase();
    
    let candidates = [];
    
    // 1. Try exact match first
    const exactMatch = globalMemory.contextPairs.find(pair => 
      pair.input === inputLower
    );
    if (exactMatch) return exactMatch.response;
    
    // 2. Try semantic cluster matching
    keywords.forEach(keyword => {
      if (globalMemory.semanticClusters[keyword]) {
        candidates = candidates.concat(globalMemory.semanticClusters[keyword]);
      }
    });
    
    // 3. Score candidates by relevance
    if (candidates.length > 0) {
      const scored = candidates.map(candidate => {
        const candidateKeywords = this.extractKeywords(candidate.input);
        const overlap = keywords.filter(k => candidateKeywords.includes(k)).length;
        const relevanceScore = overlap / Math.max(keywords.length, 1);
        
        return {
          ...candidate,
          relevanceScore: relevanceScore * candidate.quality
        };
      });
      
      scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
      
      // Return if high enough confidence
      if (scored[0].relevanceScore > 30) {
        return scored[0].response;
      }
    }
    
    return null;
  }
}

// API Endpoints
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId = 'default' } = req.body;
    
    // Clean the user message
    const cleanedMessage = TextCleaner.clean(message);
    
    if (!cleanedMessage || GarbageClassifier.isGarbage(cleanedMessage)) {
      return res.json({
        response: "Let's keep our conversation meaningful and respectful! 😊",
        learned: false,
        stats: globalMemory.stats
      });
    }
    
    // Try to find a learned response
    let response = IntelligentLearner.findBestResponse(cleanedMessage);
    let isLearned = !!response;
    
    // Fallback responses if nothing learned
    if (!response) {
      const fallbacks = [
        "oh really? tell me more about that",
        "that's interesting, what else?",
        "hmm i don't know much about that yet, but i'm learning!",
        "cool! what made you think of that?",
        "i see, keep going",
        "interesting! what else comes to mind?",
        "yeah? tell me more",
        "that's new to me, what else should i know?",
        "good question lol, what do you think?",
        "ooh that's cool, continue",
        "i'm still learning about this tbh",
        "nice! what else?",
        "fr? that's interesting",
        "i hear you, go on",
        "makes sense, what else?"
      ];
      response = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
    
    // Store conversation in buffer for potential learning
    if (!conversationBuffer.has(sessionId)) {
      conversationBuffer.set(sessionId, []);
    }
    const history = conversationBuffer.get(sessionId);
    history.push({ user: cleanedMessage, ai: response, timestamp: Date.now() });
    
    // Track active session
    activeSessions.set(sessionId, Date.now());
    
    // Keep only last 10 exchanges per session
    if (history.length > 10) {
      history.shift();
    }
    
    // Auto-learn from quality conversations after 3+ exchanges
    if (history.length >= 3) {
      // Learn from the conversation pair 2 messages ago (gives context)
      const learningIndex = history.length - 2;
      if (learningIndex >= 0) {
        const pair = history[learningIndex];
        
        // Only learn if both messages pass quality checks
        if (!GarbageClassifier.isGarbage(pair.user) && !GarbageClassifier.isGarbage(pair.ai)) {
          const quality = GarbageClassifier.calculateQuality(pair.user, pair.ai);
          
          if (quality >= 50) { // Higher threshold for live learning
            IntelligentLearner.learnPattern(pair.user, pair.ai, quality);
            globalMemory.stats.liveConversationsLearned++;
            
            // Save every 5 live learnings
            if (globalMemory.stats.liveConversationsLearned % 5 === 0) {
              await saveMemory();
            }
          }
        }
      }
    }
    
    globalMemory.stats.totalMessages++;
    
    // Periodic save every 20 messages
    if (globalMemory.stats.totalMessages % 20 === 0) {
      await saveMemory();
    }
    
    res.json({
      response,
      learned: isLearned,
      stats: globalMemory.stats,
      activeUsers: activeSessions.size
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/train', async (req, res) => {
  try {
    const { conversations, batchSize = 100 } = req.body;
    
    if (!conversations || !Array.isArray(conversations)) {
      return res.status(400).json({ error: 'Invalid conversations format' });
    }
    
    let learned = 0;
    let filtered = 0;
    
    // Process in batches
    for (let i = 0; i < conversations.length; i += batchSize) {
      const batch = conversations.slice(i, i + batchSize);
      
      for (const conv of batch) {
        let { input, response } = conv;
        
        // Clean text to remove conversation prefixes
        input = TextCleaner.clean(input);
        response = TextCleaner.clean(response);
        
        // Skip if cleaning removed everything
        if (!input || !response) {
          filtered++;
          globalMemory.stats.garbageFiltered++;
          continue;
        }
        
        // Filter garbage
        if (GarbageClassifier.isGarbage(input) || GarbageClassifier.isGarbage(response)) {
          filtered++;
          globalMemory.stats.garbageFiltered++;
          continue;
        }
        
        // Calculate quality
        const quality = GarbageClassifier.calculateQuality(input, response);
        
        // Only learn if quality is acceptable
        if (quality >= 40) {
          IntelligentLearner.learnPattern(input, response, quality);
          learned++;
          globalMemory.stats.trainingDataPoints++;
        } else {
          filtered++;
          globalMemory.stats.garbageFiltered++;
        }
      }
      
      // Periodic save
      if (i % 500 === 0 && i > 0) {
        await saveMemory();
      }
    }
    
    await saveMemory();
    
    res.json({
      success: true,
      learned,
      filtered,
      totalProcessed: conversations.length,
      stats: globalMemory.stats
    });
  } catch (error) {
    console.error('Training error:', error);
    res.status(500).json({ error: 'Training failed' });
  }
});

app.get('/api/stats', (req, res) => {
  // Clean up old sessions (>5 minutes inactive)
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
  for (const [sessionId, lastActivity] of activeSessions.entries()) {
    if (lastActivity < fiveMinutesAgo) {
      activeSessions.delete(sessionId);
    }
  }
  
  res.json({
    stats: globalMemory.stats,
    activeUsers: activeSessions.size,
    memorySize: {
      contextPairs: globalMemory.contextPairs.length,
      semanticClusters: Object.keys(globalMemory.semanticClusters).length,
      totalLearned: globalMemory.contextPairs.length + 
        Object.values(globalMemory.semanticClusters).reduce((sum, cluster) => sum + cluster.length, 0)
    }
  });
});

// Initialize and start server
loadMemory().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 TuringAI running on port ${PORT}`);
    console.log(`📊 Stats: ${globalMemory.stats.trainingDataPoints} trained, ${globalMemory.stats.liveConversationsLearned} live learned, ${globalMemory.stats.garbageFiltered} filtered`);
    console.log(`🌍 Global learning: Everyone who chats contributes to shared knowledge!`);
  });
});
