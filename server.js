const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// Simple logger utility
const logger = {
  info: (msg, data = {}) => {
    console.log(JSON.stringify({ level: 'INFO', time: new Date().toISOString(), msg, ...data }));
  },
  error: (msg, error, data = {}) => {
    console.error(JSON.stringify({
      level: 'ERROR',
      time: new Date().toISOString(),
      msg,
      error: error?.message || error,
      stack: error?.stack,
      ...data
    }));
  },
  warn: (msg, data = {}) => {
    console.warn(JSON.stringify({ level: 'WARN', time: new Date().toISOString(), msg, ...data }));
  }
};

// Rate limiting
const rateLimits = new Map(); // IP -> { count, resetTime }
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 60; // 60 requests per minute per IP

function checkRateLimit(ip) {
  const now = Date.now();
  const limit = rateLimits.get(ip);

  if (!limit || now > limit.resetTime) {
    rateLimits.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }

  if (limit.count >= RATE_LIMIT_MAX) {
    return false;
  }

  limit.count++;
  return true;
}

// Write queue to prevent race conditions
let saveQueue = Promise.resolve();
let saveScheduled = false;

function queueSave() {
  if (saveScheduled) return; // Already scheduled
  saveScheduled = true;

  // Schedule save on next tick to batch multiple rapid calls
  setImmediate(() => {
    saveQueue = saveQueue.then(async () => {
      saveScheduled = false;
      await saveMemory();
      logger.info('Memory saved to disk');
    }).catch(err => {
      saveScheduled = false;
      logger.error('Queued save failed', err);
    });
  });
}

// Graceful shutdown - save memory before exit
async function gracefulShutdown(signal) {
  logger.info('Shutdown signal received', { signal });

  try {
    // Wait for any pending saves
    await saveQueue;
    // Force final save
    await saveMemory();
    logger.info('Final memory save completed');
  } catch (err) {
    logger.error('Error during shutdown save', err);
  }

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // nodemon restart

// Middleware
app.use(bodyParser.json({ limit: '50mb' }));

// Rate limiting middleware
app.use((req, res, next) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  if (!checkRateLimit(ip)) {
    logger.warn('Rate limit exceeded', { ip, path: req.path });
    return res.status(429).json({ error: 'Too many requests' });
  }

  next();
});

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
    logger.info('Memory loaded from disk', {
      contextPairs: globalMemory.contextPairs?.length || 0,
      semanticClusters: Object.keys(globalMemory.semanticClusters || {}).length
    });
  } catch (error) {
    logger.info('Starting with fresh memory');
  }
}

async function saveMemory() {
  try {
    await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
    await fs.writeFile(MEMORY_FILE, JSON.stringify(globalMemory));
  } catch (error) {
    logger.error('Failed to save memory', error);
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

    // Stricter length requirements
    if (lower.length < 1 || lower.length > 500) return true;

    // Stricter special character filtering
    const specialCharRatio = (text.match(/[^a-zA-Z0-9\s.,!?'-]/g) || []).length / text.length;
    if (specialCharRatio > 0.3) return true;

    // Spam patterns
    const spamPatterns = [
      /click here/i,
      /buy now/i,
      /limited time/i,
      /act now/i,
      /free money/i,
      /\b(viagra|cialis|casino)\b/i,
      /http[s]?:\/\/[^\s]{20,}/i, // Long URLs
      /(.)\1{5,}/, // Repeated characters (stricter)
      /\d{5,}/, // Long number sequences (stricter)
      /\b(subscribe|follow me|check out my)\b/i,
    ];

    if (spamPatterns.some(pattern => pattern.test(text))) return true;

    // Offensive/harmful content
    const harmfulPatterns = [
      /\b(kill yourself|kys)\b/i,
      /\b(n[i1]gg[ae]r|f[a4]gg[o0]t)\b/i,
      /\b(retard|autis[tm])\b/i,
    ];

    if (harmfulPatterns.some(pattern => pattern.test(text))) return true;

    // Stricter shouting detection
    const words = text.split(/\s+/);
    const upperWords = words.filter(w => w === w.toUpperCase() && w.length > 1);
    if (upperWords.length / words.length > 0.6) return true;

    // Filter out single-word responses that are too generic
    if (words.length === 1) {
      const genericWords = ['ok', 'k', 'lol', 'yeah', 'yep', 'nope', 'idk', 'bruh', 'oof'];
      if (genericWords.includes(lower)) return true;
    }

    // Filter gibberish - too few vowels
    const vowelRatio = (lower.match(/[aeiou]/g) || []).length / lower.length;
    if (vowelRatio < 0.15 && lower.length > 3) return true;

    return false;
  }
  
  static calculateQuality(input, response) {
    let score = 40; // Lower base score - be more selective

    const inputWords = input.split(/\s+/).length;
    const responseWords = response.split(/\s+/).length;

    // Reward reasonable input length (2+ words is better)
    if (inputWords >= 2 && inputWords <= 50) score += 20;
    else if (inputWords === 1) score += 5; // Small bonus for single words

    // Reward meaningful responses (2+ words preferred)
    if (responseWords >= 2 && responseWords <= 100) score += 25;
    else if (responseWords === 1) score += 10;

    // Bonus for conversational responses
    if (responseWords >= 3 && responseWords <= 20) score += 10;

    // Penalize very short exchanges
    if (inputWords === 1 && responseWords === 1) score -= 20;

    // Bonus for punctuation (shows effort)
    if (response.match(/[.!?]$/)) score += 5;

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
    const inputLower = input.toLowerCase();

    // Create semantic clusters with relearning support
    keywords.forEach(keyword => {
      if (!globalMemory.semanticClusters[keyword]) {
        globalMemory.semanticClusters[keyword] = [];
      }

      // Check if this exact input already exists
      const existingIndex = globalMemory.semanticClusters[keyword].findIndex(
        item => item.input === inputLower
      );

      if (existingIndex !== -1) {
        const existing = globalMemory.semanticClusters[keyword][existingIndex];

        // If same response, reinforce it (increase confidence)
        if (existing.response === response) {
          existing.confidence = (existing.confidence || 1) + 1;
          existing.quality = Math.min(100, existing.quality + 2); // Small quality boost
          existing.timestamp = Date.now();
        } else {
          // Different response - only replace if new quality is significantly better
          // OR if pattern is old (allow relearning over time)
          const ageInDays = (Date.now() - existing.timestamp) / (1000 * 60 * 60 * 24);

          if (quality > existing.quality + 10 || ageInDays > 30) {
            // Replace with new pattern
            globalMemory.semanticClusters[keyword][existingIndex] = {
              input: inputLower,
              response,
              quality,
              confidence: 1,
              timestamp: Date.now()
            };
          }
          // Otherwise keep existing (it's more confident)
        }
      } else {
        // New pattern
        globalMemory.semanticClusters[keyword].push({
          input: inputLower,
          response,
          quality,
          confidence: 1,
          timestamp: Date.now()
        });
      }

      // Keep only top 20 highest quality responses per keyword
      globalMemory.semanticClusters[keyword].sort((a, b) => {
        const scoreA = b.quality * (b.confidence || 1);
        const scoreB = a.quality * (a.confidence || 1);
        return scoreA - scoreB;
      });
      if (globalMemory.semanticClusters[keyword].length > 20) {
        globalMemory.semanticClusters[keyword] = globalMemory.semanticClusters[keyword].slice(0, 20);
      }
    });

    // Store high-quality pairs separately with relearning
    if (quality >= 60) {
      const existingPairIndex = globalMemory.contextPairs.findIndex(
        pair => pair.input === inputLower
      );

      if (existingPairIndex !== -1) {
        const existing = globalMemory.contextPairs[existingPairIndex];

        if (existing.response === response) {
          // Reinforce
          existing.confidence = (existing.confidence || 1) + 1;
          existing.quality = Math.min(100, existing.quality + 2);
          existing.timestamp = Date.now();
        } else {
          const ageInDays = (Date.now() - existing.timestamp) / (1000 * 60 * 60 * 24);
          if (quality > existing.quality + 10 || ageInDays > 30) {
            globalMemory.contextPairs[existingPairIndex] = {
              input: inputLower,
              response,
              quality,
              confidence: 1,
              timestamp: Date.now()
            };
          }
        }
      } else {
        globalMemory.contextPairs.push({
          input: inputLower,
          response,
          quality,
          confidence: 1,
          timestamp: Date.now()
        });
      }

      // Keep only top 1000 context pairs by quality * confidence
      if (globalMemory.contextPairs.length > 1000) {
        globalMemory.contextPairs.sort((a, b) => {
          const scoreA = b.quality * (b.confidence || 1);
          const scoreB = a.quality * (a.confidence || 1);
          return scoreA - scoreB;
        });
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
  const startTime = Date.now();
  try {
    const { message, sessionId = 'default' } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    
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
    
    // Cleverbot-style learning: previous user message -> current user message
    // This learns conversational flow patterns from actual human responses
    if (history.length >= 2) {
      const prevPair = history[history.length - 2];
      const currentUserMsg = cleanedMessage;

      // Learn from user -> user patterns (ignore what the AI said in between)
      if (!GarbageClassifier.isGarbage(prevPair.user) && !GarbageClassifier.isGarbage(currentUserMsg)) {
        const quality = GarbageClassifier.calculateQuality(prevPair.user, currentUserMsg);

        if (quality >= 50) {
          // Learn: what humans say in response to previous human messages
          IntelligentLearner.learnPattern(prevPair.user, currentUserMsg, quality);
          globalMemory.stats.liveConversationsLearned++;

          // Queue save every 5 live learnings (more frequent to prevent data loss)
          if (globalMemory.stats.liveConversationsLearned % 5 === 0) {
            queueSave();
          }
        }
      }
    }

    globalMemory.stats.totalMessages++;

    // Queue periodic save every 50 messages
    if (globalMemory.stats.totalMessages % 50 === 0) {
      queueSave();
    }
    
    const duration = Date.now() - startTime;
    logger.info('Chat request processed', { sessionId, duration, learned: isLearned });

    res.json({
      response,
      learned: isLearned,
      stats: globalMemory.stats,
      activeUsers: activeSessions.size
    });
  } catch (error) {
    logger.error('Chat error', error, { sessionId: req.body?.sessionId });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/train', async (req, res) => {
  const startTime = Date.now();
  try {
    const { conversations, batchSize = 100 } = req.body;

    if (!conversations || !Array.isArray(conversations)) {
      return res.status(400).json({ error: 'Invalid conversations format' });
    }

    logger.info('Training started', { count: conversations.length, batchSize });

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
      
      // Queue periodic save
      if (i % 500 === 0 && i > 0) {
        queueSave();
      }
    }

    queueSave();

    const duration = Date.now() - startTime;
    logger.info('Training completed', { learned, filtered, duration });

    res.json({
      success: true,
      learned,
      filtered,
      totalProcessed: conversations.length,
      stats: globalMemory.stats
    });
  } catch (error) {
    logger.error('Training error', error, { conversationCount: req.body?.conversations?.length });
    res.status(500).json({ error: 'Training failed' });
  }
});

app.get('/api/stats', (req, res) => {
  // Clean up old sessions (>5 minutes inactive)
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
  let cleanedSessions = 0;

  for (const [sessionId, lastActivity] of activeSessions.entries()) {
    if (lastActivity < fiveMinutesAgo) {
      activeSessions.delete(sessionId);
      conversationBuffer.delete(sessionId);
      cleanedSessions++;
    }
  }

  if (cleanedSessions > 0) {
    logger.info('Cleaned up inactive sessions', { count: cleanedSessions });
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
    logger.info('TuringAI server started', {
      port: PORT,
      stats: globalMemory.stats
    });
  });

  // Auto-save every 5 minutes as a safety net
  setInterval(() => {
    queueSave();
  }, 5 * 60 * 1000);
});
