const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

const CONFIG = {
  // Rate limiting
  RATE_LIMIT_WINDOW_MS: 60000,
  RATE_LIMIT_MAX_REQUESTS: 60,
  
  // Message limits
  MAX_MESSAGE_LENGTH: 2000,
  MIN_MESSAGE_LENGTH: 1,
  
  // Memory & persistence
  SAVE_INTERVAL_MS: parseInt(process.env.SAVE_INTERVAL_MS, 10) || 60000,
  MAX_CONVERSATION_HISTORY: 10,
  SESSION_TIMEOUT_MS: 5 * 60 * 1000,
  MAX_SESSIONS: 1000,
  
  // Learning thresholds
  MIN_QUALITY_SCORE: 40,
  MIN_RELEVANCE_SCORE: 30,
  
  // CORS settings
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '*').split(','),
  
  // Backup settings
  BACKUP_INTERVAL_MS: 24 * 60 * 60 * 1000, // Daily backups
  MAX_BACKUPS: 7,
  
  // Performance
  ENABLE_COMPRESSION: true,
  RESPONSE_CACHE_TTL_MS: 5000,
};

// Persistent memory configuration
const IS_REPLIT = Boolean(process.env.REPL_ID || process.env.REPL_SLUG || process.env.REPLIT_DB_URL);
const DEFAULT_PERSISTENT_DIR = IS_REPLIT
  ? path.join(process.cwd(), '.turing-ai')
  : path.join(os.homedir(), '.turing-ai');
const PERSISTENT_DIR = process.env.PERSISTENT_MEMORY_DIR || DEFAULT_PERSISTENT_DIR;
const PERSISTENT_MEMORY_FILE = path.join(PERSISTENT_DIR, 'memory.json');
const BACKUP_DIR = path.join(PERSISTENT_DIR, 'backups');
const REPLIT_DB_URL = process.env.REPLIT_DB_URL;
const POSTGRES_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRESQL_URL || process.env.POSTGRES_URI;
const FORCE_SYNC_ON_LEARN = process.env.FORCE_SYNC_ON_LEARN === '1';

// ============================================================================
// DATABASE SETUP
// ============================================================================

const pgPool = POSTGRES_URL
  ? new Pool({
      connectionString: POSTGRES_URL,
      ssl: (process.env.PGSSLMODE === 'require' || /sslmode=require/i.test(POSTGRES_URL))
        ? { rejectUnauthorized: false }
        : false
    })
  : null;

let pgTableReady = null;

async function ensurePostgresTable() {
  if (!pgPool) return;
  if (!pgTableReady) {
    pgTableReady = pgPool.query(`
      CREATE TABLE IF NOT EXISTS memory_store (
        id text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_store(updated_at);
    `);
  }
  await pgTableReady;
}

// ============================================================================
// LOGGING UTILITY
// ============================================================================

class Logger {
  constructor() {
    this.requestId = null;
  }

  _log(level, msg, data = {}) {
    const logEntry = {
      level,
      time: new Date().toISOString(),
      msg,
      requestId: this.requestId,
      ...data
    };
    
    const output = JSON.stringify(logEntry);
    
    if (level === 'ERROR') {
      console.error(output);
    } else if (level === 'WARN') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  info(msg, data = {}) {
    this._log('INFO', msg, data);
  }

  error(msg, error, data = {}) {
    this._log('ERROR', msg, {
      error: error?.message || error,
      stack: error?.stack,
      ...data
    });
  }

  warn(msg, data = {}) {
    this._log('WARN', msg, data);
  }

  setRequestId(id) {
    this.requestId = id;
    return this;
  }
}

const logger = new Logger();

// ============================================================================
// METRICS COLLECTION
// ============================================================================

class MetricsCollector {
  constructor() {
    this.metrics = {
      requestCount: 0,
      errorCount: 0,
      totalResponseTime: 0,
      learningCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
      startTime: Date.now()
    };
  }

  recordRequest(duration, hasError = false) {
    this.metrics.requestCount++;
    this.metrics.totalResponseTime += duration;
    if (hasError) this.metrics.errorCount++;
  }

  recordLearning() {
    this.metrics.learningCount++;
  }

  recordCacheHit() {
    this.metrics.cacheHits++;
  }

  recordCacheMiss() {
    this.metrics.cacheMisses++;
  }

  getMetrics() {
    const avgResponseTime = this.metrics.requestCount > 0
      ? this.metrics.totalResponseTime / this.metrics.requestCount
      : 0;

    return {
      ...this.metrics,
      avgResponseTime: Math.round(avgResponseTime),
      uptime: Date.now() - this.metrics.startTime,
      errorRate: this.metrics.requestCount > 0
        ? (this.metrics.errorCount / this.metrics.requestCount) * 100
        : 0
    };
  }
}

const metrics = new MetricsCollector();

// ============================================================================
// RESPONSE CACHE
// ============================================================================

class ResponseCache {
  constructor(ttl = CONFIG.RESPONSE_CACHE_TTL_MS) {
    this.cache = new Map();
    this.ttl = ttl;
  }

  _hash(message) {
    return crypto.createHash('md5').update(message.toLowerCase().trim()).digest('hex');
  }

  get(message) {
    const key = this._hash(message);
    const entry = this.cache.get(key);
    
    if (!entry) return null;
    
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.response;
  }

  set(message, response) {
    const key = this._hash(message);
    this.cache.set(key, {
      response,
      timestamp: Date.now()
    });
    
    // Limit cache size
    if (this.cache.size > 1000) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  clear() {
    this.cache.clear();
  }
}

const responseCache = new ResponseCache();

// ============================================================================
// RATE LIMITING
// ============================================================================

class RateLimiter {
  constructor() {
    this.limits = new Map();
  }

  check(identifier) {
    const now = Date.now();
    const limit = this.limits.get(identifier);

    if (!limit || now > limit.resetTime) {
      this.limits.set(identifier, {
        count: 1,
        resetTime: now + CONFIG.RATE_LIMIT_WINDOW_MS
      });
      return { allowed: true, remaining: CONFIG.RATE_LIMIT_MAX_REQUESTS - 1 };
    }

    if (limit.count >= CONFIG.RATE_LIMIT_MAX_REQUESTS) {
      return {
        allowed: false,
        remaining: 0,
        resetTime: limit.resetTime
      };
    }

    limit.count++;
    return {
      allowed: true,
      remaining: CONFIG.RATE_LIMIT_MAX_REQUESTS - limit.count
    };
  }

  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, limit] of this.limits.entries()) {
      if (now > limit.resetTime) {
        this.limits.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.info('Rate limiter cleanup', { cleaned });
    }
  }
}

const rateLimiter = new RateLimiter();

// Cleanup rate limiter every 5 minutes
setInterval(() => rateLimiter.cleanup(), 5 * 60 * 1000);

// ============================================================================
// INPUT VALIDATION & SANITIZATION
// ============================================================================

class InputValidator {
  static validateMessage(message) {
    if (typeof message !== 'string') {
      return { valid: false, error: 'Message must be a string' };
    }

    const trimmed = message.trim();

    if (trimmed.length < CONFIG.MIN_MESSAGE_LENGTH) {
      return { valid: false, error: 'Message is too short' };
    }

    if (trimmed.length > CONFIG.MAX_MESSAGE_LENGTH) {
      return { valid: false, error: `Message exceeds maximum length of ${CONFIG.MAX_MESSAGE_LENGTH} characters` };
    }

    // Check for suspicious patterns (potential attacks)
    const suspiciousPatterns = [
      /<script/i,
      /javascript:/i,
      /on\w+\s*=/i, // Event handlers
      /data:text\/html/i,
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(message)) {
        return { valid: false, error: 'Message contains suspicious content' };
      }
    }

    return { valid: true, message: trimmed };
  }

  static validateSessionId(sessionId) {
    if (typeof sessionId !== 'string') {
      return { valid: false, error: 'Session ID must be a string' };
    }

    // Session ID should be alphanumeric with underscores
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) {
      return { valid: false, error: 'Invalid session ID format' };
    }

    return { valid: true, sessionId };
  }
}

// ============================================================================
// TEXT PROCESSING UTILITIES
// ============================================================================

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
    
    // Normalize whitespace
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    return cleaned.substring(0, CONFIG.MAX_MESSAGE_LENGTH);
  }

  static normalize(text) {
    return text.toLowerCase().trim();
  }
}

// Profanity detection with leet-speak and obfuscation handling
const DEFAULT_BANNED_WORDS = new Set([
  'fuck','fucker','fucking','shit','bitch','bastard','asshole','dick','douche','cunt','whore','slut',
  'nigger','nigga','faggot','fag','retard','spaz','kys'
]);

function normalizeForProfanity(text) {
  if (!text) return { original: '', lettersOnly: '', collapsed: '' };
  let normalized = text.normalize('NFKC').toLowerCase();
  
  // Remove diacritics
  normalized = normalized.replace(/\p{M}/gu, '');

  // Handle leet speak
  const leetMap = { '4': 'a', '@': 'a', '3': 'e', '1': 'i', '!': 'i', '0': 'o', '$': 's', '5': 's', '7': 't', '8': 'b' };
  for (const [k, v] of Object.entries(leetMap)) {
    normalized = normalized.replace(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), v);
  }

  const lettersOnly = normalized.replace(/[^a-z]/g, '');
  const collapsed = lettersOnly.replace(/(.)\1{2,}/g, '$1$1');
  return { original: normalized, lettersOnly, collapsed };
}

function containsProfanity(text) {
  if (!text) return { found: false, matches: [] };
  const lower = text.toLowerCase();
  const matches = new Set();

  // Direct word boundary matching
  for (const word of DEFAULT_BANNED_WORDS) {
    const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(lower)) matches.add(word);
  }

  // Check obfuscated versions
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
      /(.)\1{5,}/, // Repeated characters
      /\d{5,}/, // Long number sequences
      /\b(subscribe|follow me|check out my)\b/i,
    ];

    if (spamPatterns.some(pattern => pattern.test(text))) return true;

    // Offensive/harmful content
    const harmfulPatterns = [
      /\b(kill yourself|kys)\b/i
    ];

    if (harmfulPatterns.some(pattern => pattern.test(text))) return true;

    // Centralized profanity detection
    const profanity = containsProfanity(text);
    if (profanity.found) return true;

    // Stricter shouting detection
    const words = text.split(/\s+/);
    const upperWords = words.filter(w => w === w.toUpperCase() && w.length > 1);
    if (upperWords.length / words.length > 0.6) return true;

    // Filter gibberish - too few vowels (but allow short common responses)
    // Don't apply vowel check to very short messages (1-3 chars like "ok", "hi", "no")
    const vowelRatio = (lower.match(/[aeiou]/g) || []).length / lower.length;
    if (vowelRatio < 0.15 && lower.length > 4) return true;

    return false;
  }

  static containsProfanity(text) {
    return containsProfanity(text);
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

// ============================================================================
// INTELLIGENT LEARNING SYSTEM
// ============================================================================

class IntelligentLearner {
  static extractKeywords(text) {
    // Remove common stop words
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 
      'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 
      'could', 'should', 'may', 'might', 'can', 'this', 'that', 'these', 
      'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 
      'who', 'when', 'where', 'why', 'how'
    ]);
    
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
        const scoreA = a.quality * (a.confidence || 1);
        const scoreB = b.quality * (b.confidence || 1);
        return scoreB - scoreA;
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
        // New high-quality pair
        globalMemory.contextPairs.push({
          input: inputLower,
          response,
          quality,
          confidence: 1,
          timestamp: Date.now()
        });
      }

      // Limit to top 1000 pairs
      if (globalMemory.contextPairs.length > 1000) {
        globalMemory.contextPairs.sort((a, b) => {
          const scoreA = b.quality * (b.confidence || 1);
          const scoreB = a.quality * (a.confidence || 1);
          return scoreA - scoreB;
        });
        globalMemory.contextPairs = globalMemory.contextPairs.slice(0, 1000);
      }
    }

    // Update quality scores
    globalMemory.qualityScores[inputLower] = quality;
  }

  static findBestResponse(input) {
    // Optional caching layer (improvement over original)
    const cached = responseCache.get(input);
    if (cached) {
      metrics.recordCacheHit();
      return cached;
    }
    metrics.recordCacheMiss();

    const keywords = this.extractKeywords(input);
    const inputLower = input.toLowerCase();
    
    let candidates = [];
    
    // 1. Try exact match first
    const exactMatch = globalMemory.contextPairs.find(pair => 
      pair.input === inputLower
    );
    if (exactMatch) {
      // Cache the result before returning
      responseCache.set(input, exactMatch.response);
      return exactMatch.response;
    }
    
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
        const response = scored[0].response;
        // Cache the result before returning
        responseCache.set(input, response);
        return response;
      }
    }
    
    return null;
  }
}

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.conversationBuffer = new Map();
  }

  updateActivity(sessionId) {
    this.sessions.set(sessionId, Date.now());
  }

  getConversationHistory(sessionId) {
    if (!this.conversationBuffer.has(sessionId)) {
      this.conversationBuffer.set(sessionId, []);
    }
    return this.conversationBuffer.get(sessionId);
  }

  addToHistory(sessionId, userMessage, aiResponse) {
    const history = this.getConversationHistory(sessionId);
    history.push({
      user: userMessage,
      ai: aiResponse,
      timestamp: Date.now()
    });

    // Keep only recent history
    if (history.length > CONFIG.MAX_CONVERSATION_HISTORY) {
      history.shift();
    }
  }

  cleanup() {
    const cutoff = Date.now() - CONFIG.SESSION_TIMEOUT_MS;
    let cleaned = 0;

    for (const [sessionId, lastActivity] of this.sessions.entries()) {
      if (lastActivity < cutoff) {
        this.sessions.delete(sessionId);
        this.conversationBuffer.delete(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info('Session cleanup', { cleaned, active: this.sessions.size });
    }

    // Enforce max sessions limit
    if (this.sessions.size > CONFIG.MAX_SESSIONS) {
      const entries = Array.from(this.sessions.entries())
        .sort((a, b) => a[1] - b[1]);
      
      const toRemove = entries.slice(0, entries.length - CONFIG.MAX_SESSIONS);
      for (const [sessionId] of toRemove) {
        this.sessions.delete(sessionId);
        this.conversationBuffer.delete(sessionId);
      }
      
      logger.warn('Session limit enforced', { removed: toRemove.length });
    }
  }

  getActiveCount() {
    return this.sessions.size;
  }
}

const sessionManager = new SessionManager();

// Cleanup sessions every minute
setInterval(() => sessionManager.cleanup(), 60 * 1000);

// ============================================================================
// MEMORY PERSISTENCE
// ============================================================================

let globalMemory = {
  patterns: {},
  contextPairs: [],
  semanticClusters: {},
  qualityScores: {},
  stats: {
    totalMessages: 0,
    totalConversations: 0,
    trainingDataPoints: 0,
    garbageFiltered: 0,
    liveConversationsLearned: 0
  }
};

let saveQueue = Promise.resolve();
let saveScheduled = false;

const MEMORY_FILE = path.join(__dirname, 'data', 'memory.json');

async function ensureDirectories() {
  await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
  await fs.mkdir(PERSISTENT_DIR, { recursive: true });
  await fs.mkdir(BACKUP_DIR, { recursive: true });
}

async function loadMemoryFromReplitDB() {
  if (!REPLIT_DB_URL) return null;
  try {
    const res = await fetch(`${REPLIT_DB_URL}/memory`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text && text.trim() ? text : null;
  } catch (err) {
    logger.warn('Failed to read memory from Replit DB', { error: err.message });
    return null;
  }
}

async function loadMemoryFromPostgres() {
  if (!pgPool) return null;
  try {
    await ensurePostgresTable();
    const res = await pgPool.query('SELECT data FROM memory_store WHERE id = $1', ['global']);
    if (res.rowCount === 0) return null;
    const data = res.rows[0].data;
    if (!data) return null;
    return typeof data === 'string' ? data : JSON.stringify(data);
  } catch (err) {
    logger.warn('Failed to read memory from Postgres', { error: err.message });
    return null;
  }
}

async function saveMemoryToReplitDB(dataStr) {
  if (!REPLIT_DB_URL) return;
  try {
    const res = await fetch(`${REPLIT_DB_URL}/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: dataStr })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    logger.info('Memory saved to Replit DB');
  } catch (err) {
    logger.warn('Failed to save memory to Replit DB', { error: err.message });
  }
}

async function saveMemoryToPostgres(dataStr) {
  if (!pgPool) return;
  try {
    await ensurePostgresTable();
    await pgPool.query(
      'INSERT INTO memory_store (id, data, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
      ['global', dataStr]
    );
    logger.info('Memory saved to Postgres');
  } catch (err) {
    logger.warn('Failed to save memory to Postgres', { error: err.message });
  }
}

async function loadMemory() {
  await ensureDirectories();

  try {
    // Try loading from various sources in priority order
    let memoryStr = await loadMemoryFromPostgres();
    
    if (!memoryStr) {
      memoryStr = await loadMemoryFromReplitDB();
    }
    
    if (!memoryStr) {
      try {
        memoryStr = await fs.readFile(PERSISTENT_MEMORY_FILE, 'utf8');
      } catch (err) {
        // File doesn't exist yet
      }
    }
    
    if (!memoryStr) {
      try {
        memoryStr = await fs.readFile(MEMORY_FILE, 'utf8');
      } catch (err) {
        // File doesn't exist yet
      }
    }

    if (memoryStr) {
      const loaded = JSON.parse(memoryStr);
      
      // Validate loaded data structure
      if (loaded.stats && loaded.contextPairs && loaded.semanticClusters) {
        globalMemory = loaded;
        logger.info('Memory loaded successfully', {
          contextPairs: globalMemory.contextPairs.length,
          clusters: Object.keys(globalMemory.semanticClusters).length,
          stats: globalMemory.stats
        });
      } else {
        logger.warn('Invalid memory structure, using defaults');
      }
    } else {
      logger.info('No existing memory found, starting fresh');
    }
  } catch (error) {
    logger.error('Error loading memory', error);
  }
}

async function saveMemory() {
  try {
    const memoryStr = JSON.stringify(globalMemory, null, 2);

    // Save to primary file
    const tempFile = MEMORY_FILE + '.tmp';
    await fs.writeFile(tempFile, memoryStr, 'utf8');
    await fs.rename(tempFile, MEMORY_FILE);

    // Save to persistent location
    const persistentTemp = PERSISTENT_MEMORY_FILE + '.tmp';
    await fs.writeFile(persistentTemp, memoryStr, 'utf8');
    await fs.rename(persistentTemp, PERSISTENT_MEMORY_FILE);

    // Save to external stores (non-blocking)
    saveMemoryToPostgres(memoryStr).catch(err => 
      logger.error('Postgres save failed', err)
    );
    saveMemoryToReplitDB(memoryStr).catch(err => 
      logger.error('Replit DB save failed', err)
    );

    logger.info('Memory saved successfully');
  } catch (error) {
    logger.error('Failed to save memory', error);
    throw error;
  }
}

function saveMemorySync() {
  try {
    const memoryStr = JSON.stringify(globalMemory);
    const tempFile = MEMORY_FILE + '.sync.tmp';
    fsSync.writeFileSync(tempFile, memoryStr, 'utf8');
    fsSync.renameSync(tempFile, MEMORY_FILE);
    logger.info('Synchronous save completed');
  } catch (error) {
    logger.error('Synchronous save failed', error);
  }
}

function queueSave() {
  if (saveScheduled) return;
  saveScheduled = true;

  setImmediate(() => {
    saveQueue = saveQueue.then(async () => {
      saveScheduled = false;
      await saveMemory();
    }).catch(err => {
      saveScheduled = false;
      logger.error('Queued save failed', err);
    });
  });
}

// Create backups
async function createBackup() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUP_DIR, `memory-${timestamp}.json`);
    
    await fs.copyFile(MEMORY_FILE, backupFile);
    logger.info('Backup created', { file: backupFile });

    // Clean old backups
    const files = await fs.readdir(BACKUP_DIR);
    const backupFiles = files
      .filter(f => f.startsWith('memory-') && f.endsWith('.json'))
      .map(f => ({ name: f, path: path.join(BACKUP_DIR, f) }));

    if (backupFiles.length > CONFIG.MAX_BACKUPS) {
      const stats = await Promise.all(
        backupFiles.map(async f => ({
          ...f,
          mtime: (await fs.stat(f.path)).mtime
        }))
      );

      stats.sort((a, b) => b.mtime - a.mtime);
      
      for (const file of stats.slice(CONFIG.MAX_BACKUPS)) {
        await fs.unlink(file.path);
        logger.info('Old backup removed', { file: file.name });
      }
    }
  } catch (error) {
    logger.error('Backup creation failed', error);
  }
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

async function gracefulShutdown(signal) {
  logger.info('Shutdown signal received', { signal });

  try {
    await saveQueue;
    await saveMemory();
    await createBackup();
    logger.info('Graceful shutdown completed');
  } catch (err) {
    logger.error('Error during shutdown', err);
  }

  try {
    saveMemorySync();
  } catch (err) {
    logger.error('Final sync save failed', err);
  }

  if (pgPool) {
    await pgPool.end();
  }

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2'));

// ============================================================================
// MIDDLEWARE
// ============================================================================

// Request ID middleware
app.use((req, res, next) => {
  const requestId = crypto.randomBytes(16).toString('hex');
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
});

// Logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.setRequestId(req.requestId).info('Request completed', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration
    });
  });
  
  next();
});

// Body parser with size limit
app.use(bodyParser.json({ limit: '10mb' }));

// Rate limiting middleware
app.use((req, res, next) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const result = rateLimiter.check(ip);

  res.setHeader('X-RateLimit-Limit', CONFIG.RATE_LIMIT_MAX_REQUESTS);
  res.setHeader('X-RateLimit-Remaining', result.remaining);

  if (!result.allowed) {
    res.setHeader('X-RateLimit-Reset', new Date(result.resetTime).toISOString());
    logger.setRequestId(req.requestId).warn('Rate limit exceeded', { ip, path: req.path });
    return res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil((result.resetTime - Date.now()) / 1000)
    });
  }

  next();
});

// CORS middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  if (CONFIG.ALLOWED_ORIGINS.includes('*')) {
    res.header('Access-Control-Allow-Origin', '*');
  } else if (origin && CONFIG.ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID');
  res.header('Access-Control-Expose-Headers', 'X-Request-ID, X-RateLimit-Limit, X-RateLimit-Remaining');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

// Security headers
app.use((req, res, next) => {
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('X-XSS-Protection', '1; mode=block');
  res.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;");
  next();
});

app.use(express.static('public'));

// ============================================================================
// API ROUTES
// ============================================================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// Metrics endpoint
app.get('/api/metrics', (req, res) => {
  res.json({
    metrics: metrics.getMetrics(),
    sessions: {
      active: sessionManager.getActiveCount(),
      max: CONFIG.MAX_SESSIONS
    },
    memory: {
      contextPairs: globalMemory.contextPairs.length,
      semanticClusters: Object.keys(globalMemory.semanticClusters).length,
      stats: globalMemory.stats
    }
  });
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  sessionManager.cleanup();

  res.json({
    stats: globalMemory.stats,
    activeUsers: sessionManager.getActiveCount(),
    memorySize: {
      contextPairs: globalMemory.contextPairs.length,
      semanticClusters: Object.keys(globalMemory.semanticClusters).length,
      totalLearned: globalMemory.contextPairs.length +
        Object.values(globalMemory.semanticClusters).reduce((sum, cluster) => sum + cluster.length, 0)
    }
  });
});

// Text check endpoint
app.post('/api/check-text', (req, res) => {
  try {
    const { text } = req.body || {};
    
    if (typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }

    const profanity = GarbageClassifier.containsProfanity(text);
    const flagged = GarbageClassifier.isGarbage(text);

    res.json({
      text,
      flagged,
      profanityMatches: profanity.matches
    });
  } catch (err) {
    logger.setRequestId(req.requestId).error('check-text error', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  const startTime = Date.now();
  const requestLogger = logger.setRequestId(req.requestId);
  
  try {
    const { message, sessionId = 'default' } = req.body;

    // Validate input
    const messageValidation = InputValidator.validateMessage(message);
    if (!messageValidation.valid) {
      metrics.recordRequest(Date.now() - startTime, true);
      return res.status(400).json({ error: messageValidation.error });
    }

    const sessionValidation = InputValidator.validateSessionId(sessionId);
    if (!sessionValidation.valid) {
      metrics.recordRequest(Date.now() - startTime, true);
      return res.status(400).json({ error: sessionValidation.error });
    }

    const cleanedMessage = TextCleaner.clean(messageValidation.message);
    
    // Check for garbage
    if (!cleanedMessage || GarbageClassifier.isGarbage(cleanedMessage)) {
      globalMemory.stats.garbageFiltered++;
      metrics.recordRequest(Date.now() - startTime);
      
      return res.json({
        response: "Let's keep our conversation meaningful and respectful! 😊",
        learned: false,
        stats: globalMemory.stats,
        activeUsers: sessionManager.getActiveCount()
      });
    }
    
    // Update session activity
    sessionManager.updateActivity(sessionId);
    
    // Try to find a learned response
    let response = IntelligentLearner.findBestResponse(cleanedMessage);
    let isLearned = !!response;
    
    // Fallback responses
    if (!response) {
      const lower = cleanedMessage.toLowerCase();

      if (lower.match(/^(hi|hey|hello|sup|yo|greetings|howdy|wassup|what's up)\b/)) {
        const greetings = [
          "hey", "hi", "hello", "hey there", "hi!", "sup", "yo",
          "hey! how are you?", "hello! how's it going?"
        ];
        response = greetings[Math.floor(Math.random() * greetings.length)];
      } else if (lower.match(/how (are|r) (you|u)|how's it going|hows it going|what's up|whats up/)) {
        const statuses = [
          "good, you?", "pretty good!", "not bad, how about you?",
          "doing alright", "i'm good thanks", "fine, and you?", "great! how are you?"
        ];
        response = statuses[Math.floor(Math.random() * statuses.length)];
      } else if (lower.match(/^(what|where|when|who|why|how|which|whose|\?)/)) {
        const questions = [
          "what do you think?", "i'm not sure, what would you say?",
          "hmm, good question", "that's interesting, tell me your thoughts",
          "not sure tbh", "idk, what about you?", "what's your take on it?"
        ];
        response = questions[Math.floor(Math.random() * questions.length)];
      } else {
        const casual = [
          "oh really?", "interesting", "cool", "nice", "that's cool",
          "oh nice", "yeah?", "for real?", "i see", "tell me more",
          "go on", "interesting!", "oh wow", "haha nice", "that's interesting",
          "cool, tell me more", "nice! what else?", "oh that's cool",
          "i feel that", "makes sense"
        ];
        response = casual[Math.floor(Math.random() * casual.length)];
      }
    }
    
    // Store conversation and learn
    const history = sessionManager.getConversationHistory(sessionId);
    sessionManager.addToHistory(sessionId, cleanedMessage, response);
    
    // Learn from conversation patterns
    if (history.length >= 2) {
      const prevPair = history[history.length - 2];
      
      if (!GarbageClassifier.isGarbage(prevPair.user) && !GarbageClassifier.isGarbage(cleanedMessage)) {
        const quality = GarbageClassifier.calculateQuality(prevPair.user, cleanedMessage);

        if (quality >= CONFIG.MIN_QUALITY_SCORE) {
          IntelligentLearner.learnPattern(prevPair.user, cleanedMessage, quality);
          globalMemory.stats.liveConversationsLearned++;
          metrics.recordLearning();
          
          requestLogger.info('Pattern learned', {
            input: prevPair.user,
            response: cleanedMessage,
            quality,
            totalLearned: globalMemory.stats.liveConversationsLearned
          });

          if (FORCE_SYNC_ON_LEARN) {
            try {
              saveMemorySync();
            } catch (err) {
              requestLogger.error('Sync save failed', err);
            }
          } else {
            queueSave();
          }
        }
      }
    }

    globalMemory.stats.totalMessages++;

    // Periodic save
    if (globalMemory.stats.totalMessages % 10 === 0) {
      queueSave();
    }
    
    const duration = Date.now() - startTime;
    metrics.recordRequest(duration);
    
    requestLogger.info('Chat completed', {
      sessionId,
      duration,
      learned: isLearned,
      messageLength: cleanedMessage.length
    });

    res.json({
      response,
      learned: isLearned,
      stats: globalMemory.stats,
      activeUsers: sessionManager.getActiveCount(),
      requestId: req.requestId
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    metrics.recordRequest(duration, true);
    requestLogger.error('Chat error', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Deprecated training endpoint
app.post('/api/train', (req, res) => {
  logger.setRequestId(req.requestId).warn('Deprecated endpoint called');
  res.status(410).json({ error: 'Training endpoint has been removed' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.setRequestId(req.requestId).error('Unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// SERVER INITIALIZATION
// ============================================================================

loadMemory().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    logger.info('TuringAI server started', {
      port: PORT,
      stats: globalMemory.stats,
      config: {
        allowedOrigins: CONFIG.ALLOWED_ORIGINS,
        rateLimit: `${CONFIG.RATE_LIMIT_MAX_REQUESTS}/${CONFIG.RATE_LIMIT_WINDOW_MS}ms`,
        maxSessions: CONFIG.MAX_SESSIONS
      }
    });
  });

  // Auto-save interval
  setInterval(() => {
    queueSave();
  }, CONFIG.SAVE_INTERVAL_MS);

  // Backup interval
  setInterval(() => {
    createBackup();
  }, CONFIG.BACKUP_INTERVAL_MS);
});
