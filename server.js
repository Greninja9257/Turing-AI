const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 5000;

// Persistent memory path (useful for platforms like Replit where project files may be overwritten)
const PERSISTENT_DIR = process.env.PERSISTENT_MEMORY_DIR || path.join(os.homedir(), '.turing-ai');
const PERSISTENT_MEMORY_FILE = path.join(PERSISTENT_DIR, 'memory.json');

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
    // Force final save (async)
    await saveMemory();
    logger.info('Final memory save completed');
  } catch (err) {
    logger.error('Error during shutdown save', err);
  }

  // As a last-resort, attempt a synchronous save to avoid loss on abrupt exits (best-effort)
  try {
    const syncTemp = MEMORY_FILE + '.sync.tmp';
    fsSync.writeFileSync(syncTemp, JSON.stringify(globalMemory), 'utf8');
    fsSync.renameSync(syncTemp, MEMORY_FILE);
    logger.info('Synchronous final memory save completed');
  } catch (syncErr) {
    logger.error('Synchronous final save failed', syncErr);
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
    // Make sure persistent dir exists (best-effort)
    try { await fs.mkdir(PERSISTENT_DIR, { recursive: true }); } catch (e) { /* ignore */ }

    // Candidate files to consider (primary + persistent, and their .bak files)
    const candidatePaths = [
      MEMORY_FILE,
      MEMORY_FILE + '.bak',
      PERSISTENT_MEMORY_FILE,
      PERSISTENT_MEMORY_FILE + '.bak'
    ];

    // Gather existing candidates with mtime
    const existing = [];
    for (const p of candidatePaths) {
      try {
        const stat = await fs.stat(p);
        existing.push({ path: p, mtime: stat.mtimeMs });
      } catch (e) {
        // file does not exist
      }
    }

    if (existing.length === 0) {
      logger.info('No memory or backups found; starting with fresh memory', { primary: MEMORY_FILE, persistent: PERSISTENT_MEMORY_FILE });
      return;
    }

    // Prefer the most recently modified valid JSON file
    existing.sort((a, b) => b.mtime - a.mtime);

    let loaded = false;

    for (const candidate of existing) {
      try {
        const data = await fs.readFile(candidate.path, 'utf8');
        if (!data || !data.trim()) continue;

        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === 'object') {
          globalMemory = parsed;
          logger.info('Memory loaded from disk', { source: candidate.path, contextPairs: globalMemory.contextPairs?.length || 0, semanticClusters: Object.keys(globalMemory.semanticClusters || {}).length });

          // Sync chosen memory into primary and persistent locations (best-effort)
          try {
            await fs.writeFile(MEMORY_FILE + '.tmp', JSON.stringify(globalMemory), 'utf8');
            await fs.rename(MEMORY_FILE + '.tmp', MEMORY_FILE);
          } catch (e) {
            logger.warn('Failed to sync memory to primary location', { error: e.message });
          }

          try {
            await fs.mkdir(PERSISTENT_DIR, { recursive: true });
            await fs.writeFile(PERSISTENT_MEMORY_FILE + '.tmp', JSON.stringify(globalMemory), 'utf8');
            await fs.rename(PERSISTENT_MEMORY_FILE + '.tmp', PERSISTENT_MEMORY_FILE);
          } catch (e) {
            // non-fatal
            logger.warn('Failed to sync memory to persistent location', { error: e.message });
          }

          // Ensure backups exist (best-effort)
          try { await fs.copyFile(MEMORY_FILE, MEMORY_FILE + '.bak'); } catch (e) {}
          try { await fs.copyFile(PERSISTENT_MEMORY_FILE, PERSISTENT_MEMORY_FILE + '.bak'); } catch (e) {}

          loaded = true;
          break;
        }
      } catch (err) {
        logger.warn('Failed to parse or read candidate memory file; continuing', { file: candidate.path, error: err.message });
        continue;
      }
    }

    if (!loaded) {
      logger.info('No valid memory found after scanning candidates; starting with fresh memory');
    }
  } catch (error) {
    logger.error('Failed to load memory; starting with fresh memory', error);
  }
} 

async function saveMemory() {
  const dataStr = JSON.stringify(globalMemory);
  const tempFile = MEMORY_FILE + '.tmp';
  try {
    await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
    await fs.writeFile(tempFile, dataStr, 'utf8');
    await fs.rename(tempFile, MEMORY_FILE);

    try {
      const stats = await fs.stat(MEMORY_FILE);
      logger.info('Memory saved to disk', { bytes: stats.size });

      // Create a simple rotating backup (overwrite .bak) to help recovery on abrupt resets
      try {
        await fs.copyFile(MEMORY_FILE, MEMORY_FILE + '.bak');
        logger.info('Backup saved', { backup: MEMORY_FILE + '.bak' });
      } catch (bakErr) {
        // non-fatal
      }

      // Also attempt to persist a copy to the persistent directory (e.g., user's home)
      try {
        await fs.mkdir(PERSISTENT_DIR, { recursive: true });
        await fs.writeFile(PERSISTENT_MEMORY_FILE + '.tmp', dataStr, 'utf8');
        await fs.rename(PERSISTENT_MEMORY_FILE + '.tmp', PERSISTENT_MEMORY_FILE);
        try { await fs.copyFile(PERSISTENT_MEMORY_FILE, PERSISTENT_MEMORY_FILE + '.bak'); } catch (e) {}
        logger.info('Persistent copy saved', { persistent: PERSISTENT_MEMORY_FILE });
      } catch (persistErr) {
        logger.warn('Failed to save persistent copy of memory', { error: persistErr.message });
      }

    } catch (statErr) {
      logger.info('Memory saved to disk');
    }
  } catch (error) {
    // Try to clean up temp file if present
    try { await fs.unlink(tempFile); } catch (e) {}
    logger.error('Failed to save memory', error);
  }
} 

// Optionally force synchronous saves after live learning (useful on platforms that may be killed abruptly)
const FORCE_SYNC_ON_LEARN = process.env.FORCE_SYNC_ON_LEARN === '1';

function saveMemorySync() {
  try {
    const dataStr = JSON.stringify(globalMemory);
    const tempFile = MEMORY_FILE + '.sync.tmp';
    fsSync.writeFileSync(tempFile, dataStr, 'utf8');
    fsSync.renameSync(tempFile, MEMORY_FILE);

    try {
      const stats = fsSync.statSync(MEMORY_FILE);
      logger.info('Sync memory saved to disk', { bytes: stats.size });
    } catch (e) {
      logger.info('Sync memory saved to disk');
    }

    // Create/overwrite a simple .bak backup to aid recovery
    try { fsSync.copyFileSync(MEMORY_FILE, MEMORY_FILE + '.bak'); } catch (e) { /* ignore backup errors */ }

    // Also attempt to write a persistent copy (best-effort)
    try {
      fsSync.mkdirSync(PERSISTENT_DIR, { recursive: true });
      const tempPersist = PERSISTENT_MEMORY_FILE + '.sync.tmp';
      fsSync.writeFileSync(tempPersist, dataStr, 'utf8');
      fsSync.renameSync(tempPersist, PERSISTENT_MEMORY_FILE);
      try { fsSync.copyFileSync(PERSISTENT_MEMORY_FILE, PERSISTENT_MEMORY_FILE + '.bak'); } catch (e) {}
    } catch (e) {
      // non-fatal
    }
  } catch (error) {
    logger.error('Failed to sync save memory', error);
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
// Profanity helpers (normalization + simple deobfuscation)
const DEFAULT_BANNED_WORDS = new Set([
  'fuck','fucker','fucking','shit','bitch','bastard','asshole','dick','douche','cunt','whore','slut',
  'nigger','nigga','faggot','fag','retard','spaz','kys'
]);

function normalizeForProfanity(text) {
  if (!text) return { original: '', lettersOnly: '', collapsed: '' };
  let normalized = text.normalize('NFKC').toLowerCase();
  normalized = normalized.replace(/\p{M}/gu, ''); // remove diacritics

  const leetMap = { '4': 'a', '@': 'a', '3': 'e', '1': 'i', '!': 'i', '0': 'o', '\$': 's', '5': 's', '7': 't', '8': 'b' };
  for (const [k, v] of Object.entries(leetMap)) {
    normalized = normalized.replace(new RegExp(k, 'g'), v);
  }

  const lettersOnly = normalized.replace(/[^a-z]/g, '');
  const collapsed = lettersOnly.replace(/(.)\1{2,}/g, '$1$1');
  return { original: normalized, lettersOnly, collapsed };
}

function containsProfanity(text) {
  if (!text) return { found: false, matches: [] };
  const lower = text.toLowerCase();
  const matches = new Set();

  for (const word of DEFAULT_BANNED_WORDS) {
    const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(lower)) matches.add(word);
  }

  const { lettersOnly, collapsed } = normalizeForProfanity(text);
  for (const word of DEFAULT_BANNED_WORDS) {
    if (collapsed.includes(word) || lettersOnly.includes(word)) matches.add(word);
  }

  return { found: matches.size > 0, matches: Array.from(matches) };
}
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
      /\b(kill yourself|kys)\b/i
    ];

    if (harmfulPatterns.some(pattern => pattern.test(text))) return true;

    // Centralized profanity detection (handles obfuscation and leet)
    const profanity = containsProfanity(text);
    if (profanity.found) return true;

    // Stricter shouting detection
    const words = text.split(/\s+/);
    const upperWords = words.filter(w => w === w.toUpperCase() && w.length > 1);
    if (upperWords.length / words.length > 0.6) return true;

    // Don't filter single-word responses - humans use them naturally
    // Allow: ok, yeah, lol, cool, nice, etc.

    // Filter gibberish - too few vowels
    const vowelRatio = (lower.match(/[aeiou]/g) || []).length / lower.length;
    if (vowelRatio < 0.15 && lower.length > 3) return true;

    return false;
  }
  
  static calculateQuality(input, response) {
    let score = 50; // Base score - accept natural conversation

    const inputWords = input.split(/\s+/).length;
    const responseWords = response.split(/\s+/).length;

    // Accept all reasonable lengths - humans talk in varied ways
    if (inputWords >= 1 && inputWords <= 50) score += 15;
    if (responseWords >= 1 && responseWords <= 100) score += 15;

    // Bonus for multi-word responses (but don't penalize short ones)
    if (responseWords >= 3 && responseWords <= 20) score += 10;

    // Bonus for punctuation
    if (response.match(/[.!?]$/)) score += 5;

    // Small bonus for variety (not just repeating same word)
    if (input.toLowerCase() !== response.toLowerCase()) score += 5;

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
    
    // Cleverbot-style fallback responses - natural and casual
    if (!response) {
      const lower = cleanedMessage.toLowerCase();

      // Detect greetings - respond naturally
      if (lower.match(/^(hi|hey|hello|sup|yo|greetings|howdy|wassup|what's up)\b/)) {
        const greetingFallbacks = [
          "hey",
          "hi",
          "hello",
          "hey there",
          "hi!",
          "sup",
          "yo",
          "hey! how are you?",
          "hello! how's it going?",
        ];
        response = greetingFallbacks[Math.floor(Math.random() * greetingFallbacks.length)];
      }
      // Detect "how are you" type questions
      else if (lower.match(/how (are|r) (you|u)|how's it going|hows it going|what's up|whats up/)) {
        const statusFallbacks = [
          "good, you?",
          "pretty good!",
          "not bad, how about you?",
          "doing alright",
          "i'm good thanks",
          "fine, and you?",
          "great! how are you?",
        ];
        response = statusFallbacks[Math.floor(Math.random() * statusFallbacks.length)];
      }
      // Detect questions - turn them back
      else if (lower.match(/^(what|where|when|who|why|how|which|whose|\?)/)) {
        const questionFallbacks = [
          "what do you think?",
          "i'm not sure, what would you say?",
          "hmm, good question",
          "that's interesting, tell me your thoughts",
          "not sure tbh",
          "idk, what about you?",
          "what's your take on it?",
        ];
        response = questionFallbacks[Math.floor(Math.random() * questionFallbacks.length)];
      }
      // General conversational fallbacks - short and natural like humans
      else {
        const casualFallbacks = [
          "oh really?",
          "interesting",
          "cool",
          "nice",
          "that's cool",
          "oh nice",
          "yeah?",
          "for real?",
          "i see",
          "tell me more",
          "go on",
          "interesting!",
          "oh wow",
          "haha nice",
          "that's interesting",
          "cool, tell me more",
          "nice! what else?",
          "oh that's cool",
          "i feel that",
          "makes sense",
        ];
        response = casualFallbacks[Math.floor(Math.random() * casualFallbacks.length)];
      }
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

        // Lower threshold to accept natural human conversation (including short responses)
        if (quality >= 40) {
          // Learn: what humans say in response to previous human messages
          IntelligentLearner.learnPattern(prevPair.user, currentUserMsg, quality);
          globalMemory.stats.liveConversationsLearned++;
          logger.info('Live conversation learned', {
            input: prevPair.user,
            response: currentUserMsg,
            quality,
            totalLiveLearned: globalMemory.stats.liveConversationsLearned
          });

          // Immediately queue a save (batched by queueSave) to persist live learnings quickly.
          // queueSave is idempotent / debounced so this won't cause excessive writes.
          if (FORCE_SYNC_ON_LEARN) {
            try {
              saveMemorySync();
              logger.info('Sync save performed on live learn');
            } catch (err) {
              logger.error('Sync save failed on live learn', err);
            }
          } else {
            queueSave();
          }
        }
      }
    }

    globalMemory.stats.totalMessages++;

    // Queue periodic save every 10 messages (more frequent to reduce data loss)
    if (globalMemory.stats.totalMessages % 10 === 0) {
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

// Training endpoint removed — use offline tooling or admin scripts for bulk training.
// Keep a minimal 410 response so clients know the endpoint is intentionally gone.
app.post('/api/train', (req, res) => {
  logger.warn('Deprecated endpoint /api/train called');
  res.status(410).json({ error: 'Training endpoint has been removed.' });
});

app.post('/api/check-text', (req, res) => {
  try {
    const { text } = req.body || {};
    if (typeof text !== 'string') return res.status(400).json({ error: 'text is required in the request body' });

    const profanity = containsProfanity(text);
    const flagged = GarbageClassifier.isGarbage(text);

    res.json({ text, flagged, profanityMatches: profanity.matches });
  } catch (err) {
    logger.error('check-text error', err);
    res.status(500).json({ error: 'internal error' });
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

  const SAVE_INTERVAL_MS = parseInt(process.env.SAVE_INTERVAL_MS, 10) || 60 * 1000;
  logger.info('Memory persistence configured', { FORCE_SYNC_ON_LEARN, SAVE_INTERVAL_MS });
  // Auto-save as a safety net (configurable via SAVE_INTERVAL_MS env var)
  setInterval(() => {
    queueSave();
  }, SAVE_INTERVAL_MS);
});
