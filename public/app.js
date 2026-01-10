// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  MAX_MESSAGE_LENGTH: 2000,
  TYPING_DELAY: 800,
  STATS_UPDATE_INTERVAL: 300000, // 5 minutes
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000,
  CONNECTION_CHECK_INTERVAL: 30000, // 30 seconds
};

// ============================================================================
// API CLIENT
// ============================================================================

class APIClient {
  constructor() {
    this.baseURL = this._detectBaseURL();
    this.isOnline = true;
    this.retryCount = 0;
  }

  _detectBaseURL() {
    if (window.location.protocol === 'file:') {
      console.warn('Running from file://. Using default server: http://localhost:5000');
      document.getElementById('fileWarning').style.display = 'flex';
      return 'http://localhost:5000';
    }
    return window.location.origin;
  }

  async _fetch(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;
    
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `HTTP ${response.status}`);
      }

      this.isOnline = true;
      this.retryCount = 0;
      return await response.json();
    } catch (error) {
      if (error.name === 'TypeError' || error.message.includes('Failed to fetch')) {
        this.isOnline = false;
      }
      throw error;
    }
  }

  async _retryFetch(endpoint, options, attempt = 0) {
    try {
      return await this._fetch(endpoint, options);
    } catch (error) {
      if (attempt < CONFIG.RETRY_ATTEMPTS - 1) {
        await this._delay(CONFIG.RETRY_DELAY * (attempt + 1));
        return this._retryFetch(endpoint, options, attempt + 1);
      }
      throw error;
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async sendMessage(message, sessionId) {
    return this._retryFetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message, sessionId }),
    });
  }

  async getStats() {
    return this._fetch('/api/stats');
  }

  async checkHealth() {
    return this._fetch('/health');
  }
}

// ============================================================================
// SESSION MANAGER
// ============================================================================

class SessionManager {
  constructor() {
    this.sessionId = this._generateSessionId();
    this.messageCount = 0;
  }

  _generateSessionId() {
    const stored = localStorage.getItem('turingai_session_id');
    if (stored) return stored;

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem('turingai_session_id', sessionId);
    return sessionId;
  }

  getSessionId() {
    return this.sessionId;
  }

  incrementMessageCount() {
    this.messageCount++;
    return this.messageCount;
  }

  getMessageCount() {
    return this.messageCount;
  }
}

// ============================================================================
// MESSAGE MANAGER
// ============================================================================

class MessageManager {
  constructor(container) {
    this.container = container;
    this.messages = [];
  }

  addMessage(text, isUser, metadata = {}) {
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date();

    const message = {
      id: messageId,
      text: this._sanitize(text),
      isUser,
      timestamp,
      ...metadata,
    };

    this.messages.push(message);
    this._renderMessage(message);
    this._hideEmptyState();
    this._scrollToBottom();

    return message;
  }

  _sanitize(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  _renderMessage(message) {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${message.isUser ? 'user' : 'ai'}`;
    messageEl.id = message.id;
    messageEl.setAttribute('role', 'article');
    messageEl.setAttribute('aria-label', `${message.isUser ? 'You' : 'AI'} said: ${message.text}`);

    const time = message.timestamp.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    });

    messageEl.innerHTML = `
      <div class="message-avatar" aria-hidden="true">${message.isUser ? 'You' : 'AI'}</div>
      <div class="message-content">
        <div class="message-bubble">${message.text}</div>
        <div class="message-meta">
          <span class="message-time">${time}</span>
        </div>
      </div>
    `;

    this.container.appendChild(messageEl);
  }

  clear() {
    this.messages = [];
    this.container.innerHTML = '';
    this._showEmptyState();
    
    // Announce to screen readers
    const announcement = document.createElement('div');
    announcement.setAttribute('role', 'status');
    announcement.setAttribute('aria-live', 'polite');
    announcement.className = 'sr-only';
    announcement.textContent = 'Chat cleared';
    document.body.appendChild(announcement);
    setTimeout(() => announcement.remove(), 1000);
  }

  _hideEmptyState() {
    const emptyState = document.getElementById('emptyState');
    if (emptyState) {
      emptyState.style.display = 'none';
    }
  }

  _showEmptyState() {
    const emptyState = document.getElementById('emptyState');
    if (emptyState) {
      emptyState.style.display = 'flex';
    }
  }

  _scrollToBottom() {
    // Use smooth scrolling
    this.container.scrollTo({
      top: this.container.scrollHeight,
      behavior: 'smooth'
    });
  }

  getMessages() {
    return this.messages;
  }
}

// ============================================================================
// UI CONTROLLER
// ============================================================================

class UIController {
  constructor() {
    this.elements = {
      chatInput: document.getElementById('chatInput'),
      sendBtn: document.getElementById('sendBtn'),
      clearBtn: document.getElementById('clearBtn'),
      helpBtn: document.getElementById('helpBtn'),
      typingIndicator: document.getElementById('typingIndicator'),
      statusDot: document.getElementById('statusDot'),
      statusText: document.getElementById('statusText'),
      charCounter: document.getElementById('charCounter'),
      errorBanner: document.getElementById('errorBanner'),
      errorText: document.getElementById('errorText'),
      chatSubtitle: document.getElementById('chatSubtitle'),
      shortcutsTooltip: document.getElementById('shortcutsTooltip'),
      loadingOverlay: document.getElementById('loadingOverlay'),
      // Stats
      statKnowledgeSize: document.getElementById('statKnowledgeSize'),
      statActiveUsers: document.getElementById('statActiveUsers'),
      statMessages: document.getElementById('statMessages'),
    };

    this._initEventListeners();
    this._initBackgroundCanvas();
  }

  _initEventListeners() {
    // Input handling
    this.elements.chatInput.addEventListener('input', () => {
      this._autoResize();
      this._updateCharCounter();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Escape: Clear input
      if (e.key === 'Escape') {
        this.elements.chatInput.value = '';
        this._autoResize();
        this._updateCharCounter();
      }

      // ?: Show shortcuts
      if (e.key === '?' && !e.shiftKey && document.activeElement !== this.elements.chatInput) {
        e.preventDefault();
        this.toggleShortcuts();
      }
    });

    // Button clicks
    this.elements.clearBtn.addEventListener('click', () => {
      this.elements.chatInput.value = '';
      this._autoResize();
      this._updateCharCounter();
      this.elements.chatInput.focus();
    });

    this.elements.helpBtn.addEventListener('click', () => {
      this.toggleShortcuts();
    });

    // Click outside shortcuts to close
    document.addEventListener('click', (e) => {
      if (!this.elements.shortcutsTooltip.contains(e.target) &&
          !this.elements.helpBtn.contains(e.target)) {
        this.elements.shortcutsTooltip.classList.remove('visible');
      }
    });
  }

  _initBackgroundCanvas() {
    const canvas = document.getElementById('bgCanvas');
    const ctx = canvas.getContext('2d');

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    resize();
    window.addEventListener('resize', resize);

    // Animated grid
    let offset = 0;
    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = 'rgba(42, 42, 58, 0.3)';
      ctx.lineWidth = 1;

      const gridSize = 50;
      offset = (offset + 0.2) % gridSize;

      for (let x = -offset; x < canvas.width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }

      for (let y = -offset; y < canvas.height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      requestAnimationFrame(animate);
    };

    animate();
  }

  _autoResize() {
    const input = this.elements.chatInput;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 150) + 'px';
  }

  _updateCharCounter() {
    const length = this.elements.chatInput.value.length;
    this.elements.charCounter.textContent = `${length}/${CONFIG.MAX_MESSAGE_LENGTH}`;
    
    if (length > CONFIG.MAX_MESSAGE_LENGTH * 0.9) {
      this.elements.charCounter.classList.add('warning');
    } else {
      this.elements.charCounter.classList.remove('warning');
    }
  }

  showTyping() {
    this.elements.typingIndicator.classList.add('active');
  }

  hideTyping() {
    this.elements.typingIndicator.classList.remove('active');
  }

  clearInput() {
    this.elements.chatInput.value = '';
    this._autoResize();
    this._updateCharCounter();
  }

  focusInput() {
    this.elements.chatInput.focus();
  }

  getInputValue() {
    return this.elements.chatInput.value.trim();
  }

  setInputEnabled(enabled) {
    this.elements.chatInput.disabled = !enabled;
    this.elements.sendBtn.disabled = !enabled;
  }

  updateConnectionStatus(isConnected) {
    if (isConnected) {
      this.elements.statusDot.className = 'status-dot connected';
      this.elements.statusText.textContent = 'Connected';
      this.hideError();
    } else {
      this.elements.statusDot.className = 'status-dot disconnected';
      this.elements.statusText.textContent = 'Disconnected';
      this.showError('Unable to connect to server. Please check your connection.');
    }
  }

  showError(message) {
    this.elements.errorText.textContent = message;
    this.elements.errorBanner.style.display = 'flex';
  }

  hideError() {
    this.elements.errorBanner.style.display = 'none';
  }

  updateStats(stats, activeUsers) {
    if (!stats) return;

    // Knowledge base size
    const knowledgeSize = (stats.trainingDataPoints || 0) + (stats.liveConversationsLearned || 0);
    this.elements.statKnowledgeSize.textContent = this._formatNumber(knowledgeSize);

    // Active users
    if (activeUsers !== undefined) {
      this.elements.statActiveUsers.textContent = activeUsers;
    }

    // Messages
    if (stats.totalMessages !== undefined) {
      this.elements.statMessages.textContent = this._formatNumber(stats.totalMessages);
    }

    // Update subtitle
    const learned = stats.liveConversationsLearned || 0;
    this.elements.chatSubtitle.textContent = `${this._formatNumber(learned)} patterns learned`;
  }

  _formatNumber(num) {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    } else if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'k';
    }
    return num.toString();
  }

  toggleShortcuts() {
    this.elements.shortcutsTooltip.classList.toggle('visible');
  }

  hideLoading() {
    setTimeout(() => {
      this.elements.loadingOverlay.style.display = 'none';
    }, 500);
  }
}

// ============================================================================
// APPLICATION
// ============================================================================

class TuringAI {
  constructor() {
    this.api = new APIClient();
    this.session = new SessionManager();
    this.ui = new UIController();
    this.messages = new MessageManager(document.getElementById('chatMessages'));
    
    this.statsUpdateInterval = null;
    this.connectionCheckInterval = null;

    this._init();
  }

  async _init() {
    // Setup event handlers
    this.ui.elements.sendBtn.addEventListener('click', () => this.sendMessage());
    this.ui.elements.chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // Check initial connection
    await this.checkConnection();

    // Load initial stats
    await this.updateStats();

    // Start periodic updates
    this.startPeriodicUpdates();

    // Hide loading overlay
    this.ui.hideLoading();

    // Focus input
    this.ui.focusInput();
  }

  async sendMessage() {
    const message = this.ui.getInputValue();

    if (!message || message.length === 0) {
      return;
    }

    if (message.length > CONFIG.MAX_MESSAGE_LENGTH) {
      this.ui.showError(`Message is too long. Maximum ${CONFIG.MAX_MESSAGE_LENGTH} characters.`);
      return;
    }

    // Disable input while processing
    this.ui.setInputEnabled(false);

    // Add user message
    this.messages.addMessage(message, true);
    this.ui.clearInput();
    this.ui.showTyping();

    try {
      // Send to API
      const response = await this.api.sendMessage(message, this.session.getSessionId());

      // Simulate typing delay
      await this._delay(CONFIG.TYPING_DELAY);

      // Add AI response
      this.ui.hideTyping();
      this.messages.addMessage(response.response, false, {
        learned: response.learned
      });

      // Update stats
      if (response.stats) {
        this.ui.updateStats(response.stats, response.activeUsers);
      }

      // Update session
      this.session.incrementMessageCount();

    } catch (error) {
      console.error('Send message error:', error);
      this.ui.hideTyping();
      
      if (!this.api.isOnline) {
        this.ui.updateConnectionStatus(false);
        this.messages.addMessage(
          "I'm having trouble connecting to the server. Please check your internet connection.",
          false
        );
      } else {
        this.ui.showError(error.message || 'Failed to send message. Please try again.');
        this.messages.addMessage(
          "Sorry, I encountered an error. Please try again.",
          false
        );
      }
    } finally {
      this.ui.setInputEnabled(true);
      this.ui.focusInput();
    }
  }

  clearChat() {
    this.messages.clear();
    this.ui.hideError();
    this.ui.focusInput();
  }

  async updateStats() {
    try {
      const data = await this.api.getStats();
      this.ui.updateStats(data.stats, data.activeUsers);
      this.ui.updateConnectionStatus(true);
    } catch (error) {
      console.error('Stats update error:', error);
      // Don't show error for background updates
    }
  }

  async checkConnection() {
    try {
      await this.api.checkHealth();
      this.ui.updateConnectionStatus(true);
    } catch (error) {
      console.error('Connection check failed:', error);
      this.ui.updateConnectionStatus(false);
    }
  }

  startPeriodicUpdates() {
    // Update stats every 5 minutes
    this.statsUpdateInterval = setInterval(() => {
      this.updateStats();
    }, CONFIG.STATS_UPDATE_INTERVAL);

    // Check connection every 30 seconds
    this.connectionCheckInterval = setInterval(() => {
      this.checkConnection();
    }, CONFIG.CONNECTION_CHECK_INTERVAL);
  }

  stopPeriodicUpdates() {
    if (this.statsUpdateInterval) {
      clearInterval(this.statsUpdateInterval);
    }
    if (this.connectionCheckInterval) {
      clearInterval(this.connectionCheckInterval);
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// INITIALIZE APPLICATION
// ============================================================================

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.app = new TuringAI();
  });
} else {
  window.app = new TuringAI();
}

// Handle page visibility for connection checks
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && window.app) {
    window.app.checkConnection();
    window.app.updateStats();
  }
});

// Handle online/offline events
window.addEventListener('online', () => {
  if (window.app) {
    window.app.ui.updateConnectionStatus(true);
    window.app.checkConnection();
  }
});

window.addEventListener('offline', () => {
  if (window.app) {
    window.app.ui.updateConnectionStatus(false);
  }
});
