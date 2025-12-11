/**
 * Task Queue Frontend
 * 
 * Handles:
 * - Task submission
 * - Server-Sent Events (SSE) for real-time updates
 * - UI rendering for queue state
 * 
 * KEY CONCEPTS:
 * - EventSource API for SSE
 * - Reactive UI updates
 * - State management
 */

// ============================================
// Application State
// ============================================

const state = {
  tasks: [],
  stats: {
    pending: 0,
    processing: 0,
    retrying: 0,
    completed: 0,
    failed: 0
  },
  isConnected: false,
  eventSource: null
};

// ============================================
// DOM Elements
// ============================================

const elements = {
  form: document.getElementById('submit-form'),
  promptInput: document.getElementById('prompt-input'),
  submitBtn: document.getElementById('submit-btn'),
  formError: document.getElementById('form-error'),
  taskList: document.getElementById('task-list'),
  connectionStatus: document.getElementById('connection-status'),
  stats: {
    pending: document.getElementById('stat-pending'),
    processing: document.getElementById('stat-processing'),
    retrying: document.getElementById('stat-retrying'),
    completed: document.getElementById('stat-completed'),
    failed: document.getElementById('stat-failed')
  }
};

// ============================================
// SSE Connection
// ============================================

/**
 * Connect to Server-Sent Events stream
 * 
 * WHY SSE: It's simpler than WebSockets for one-way server→client communication.
 * The browser handles reconnection automatically. Perfect for real-time dashboards.
 * 
 * EventSource is the browser's built-in SSE client. It:
 * - Opens a persistent HTTP connection
 * - Parses incoming events
 * - Automatically reconnects on disconnect
 */
function connectSSE() {
  // Close existing connection if any
  if (state.eventSource) {
    state.eventSource.close();
  }

  console.log('[SSE] Connecting...');
  state.eventSource = new EventSource('/queue/stream');

  // Connection opened
  state.eventSource.onopen = () => {
    console.log('[SSE] Connected');
    setConnected(true);
  };

  // Connection error
  state.eventSource.onerror = (error) => {
    console.error('[SSE] Error:', error);
    setConnected(false);
    
    // EventSource will automatically reconnect
    // We just need to update the UI
  };

  // === Event Handlers ===
  
  /**
   * Queue snapshot - full state on connect/reconnect
   * 
   * WHY FULL SNAPSHOT: When the client (re)connects, it needs the complete
   * current state, not just incremental updates since some unknown point.
   */
  state.eventSource.addEventListener('queue_snapshot', (event) => {
    const tasks = JSON.parse(event.data);
    state.tasks = tasks;
    renderTaskList();
    console.log(`[Queue] Received snapshot: ${tasks.length} tasks`);
  });

  /**
   * Queue stats update
   */
  state.eventSource.addEventListener('queue_stats', (event) => {
    state.stats = JSON.parse(event.data);
    renderStats();
  });

  /**
   * New task submitted
   */
  state.eventSource.addEventListener('task_submitted', (event) => {
    const task = JSON.parse(event.data);
    addOrUpdateTask(task);
    console.log(`[Task] Submitted: ${task.id}`);
  });

  /**
   * Task started processing
   */
  state.eventSource.addEventListener('task_started', (event) => {
    const task = JSON.parse(event.data);
    addOrUpdateTask(task);
    console.log(`[Task] Started: ${task.id}`);
  });

  /**
   * Task progress update
   */
  state.eventSource.addEventListener('task_progress', (event) => {
    const { id, progress } = JSON.parse(event.data);
    updateTaskProgress(id, progress);
  });

  /**
   * Task completed successfully
   */
  state.eventSource.addEventListener('task_completed', (event) => {
    const task = JSON.parse(event.data);
    addOrUpdateTask(task);
    console.log(`[Task] Completed: ${task.id}`);
  });

  /**
   * Task failed permanently
   */
  state.eventSource.addEventListener('task_failed', (event) => {
    const task = JSON.parse(event.data);
    addOrUpdateTask(task);
    console.log(`[Task] Failed: ${task.id}`);
  });

  /**
   * Retry scheduled
   */
  state.eventSource.addEventListener('task_retry_scheduled', (event) => {
    const data = JSON.parse(event.data);
    const task = state.tasks.find(t => t.id === data.id);
    if (task) {
      task.state = 'retrying';
      task.retryCount = data.retryCount;
      task.maxRetries = data.maxRetries;
      task.nextRetryAt = data.nextRetryAt;
      task.error = data.error;
      renderTaskList();
    }
    console.log(`[Task] Retry scheduled: ${data.id} (attempt ${data.retryCount})`);
  });

  /**
   * Task requeued for retry
   */
  state.eventSource.addEventListener('task_requeued', (event) => {
    const task = JSON.parse(event.data);
    addOrUpdateTask(task);
    console.log(`[Task] Requeued: ${task.id}`);
  });

  /**
   * Task cancelled
   */
  state.eventSource.addEventListener('task_cancelled', (event) => {
    const { id } = JSON.parse(event.data);
    state.tasks = state.tasks.filter(t => t.id !== id);
    renderTaskList();
    console.log(`[Task] Cancelled: ${id}`);
  });
}

/**
 * Update connection status in UI
 */
function setConnected(connected) {
  state.isConnected = connected;
  const statusEl = elements.connectionStatus;
  
  if (connected) {
    statusEl.classList.remove('disconnected');
    statusEl.classList.add('connected');
    statusEl.querySelector('.status-text').textContent = 'Connected';
  } else {
    statusEl.classList.remove('connected');
    statusEl.classList.add('disconnected');
    statusEl.querySelector('.status-text').textContent = 'Reconnecting...';
  }
}

// ============================================
// State Management
// ============================================

/**
 * Add a new task or update existing one
 */
function addOrUpdateTask(task) {
  const index = state.tasks.findIndex(t => t.id === task.id);
  
  if (index >= 0) {
    state.tasks[index] = task;
  } else {
    state.tasks.unshift(task); // Add to front (newest first)
  }
  
  renderTaskList();
}

/**
 * Update just the progress of a task (without full re-render)
 */
function updateTaskProgress(taskId, progress) {
  const task = state.tasks.find(t => t.id === taskId);
  if (task) {
    task.progress = progress;
  }
  
  // Update progress bar directly for smoother animation
  const progressFill = document.querySelector(`[data-task-id="${taskId}"] .progress-fill`);
  const progressPercent = document.querySelector(`[data-task-id="${taskId}"] .progress-percent`);
  
  if (progressFill) {
    progressFill.style.width = `${progress}%`;
  }
  if (progressPercent) {
    progressPercent.textContent = `${progress}%`;
  }
}

// ============================================
// Form Handling
// ============================================

/**
 * Submit a new task
 */
async function submitTask(prompt) {
  elements.submitBtn.disabled = true;
  elements.formError.textContent = '';
  
  try {
    const response = await fetch('/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to submit task');
    }
    
    // Clear input on success
    elements.promptInput.value = '';
    
  } catch (error) {
    elements.formError.textContent = error.message;
  } finally {
    elements.submitBtn.disabled = false;
    elements.promptInput.focus();
  }
}

// ============================================
// Rendering
// ============================================

/**
 * Render queue statistics
 */
function renderStats() {
  elements.stats.pending.textContent = state.stats.pending || 0;
  elements.stats.processing.textContent = state.stats.processing || 0;
  elements.stats.retrying.textContent = state.stats.retrying || 0;
  elements.stats.completed.textContent = state.stats.completed || 0;
  elements.stats.failed.textContent = state.stats.failed || 0;
}

/**
 * Render the task list
 */
function renderTaskList() {
  if (state.tasks.length === 0) {
    elements.taskList.innerHTML = `
      <div class="empty-state">
        <p>No tasks yet. Submit a prompt above to get started!</p>
      </div>
    `;
    return;
  }
  
  // Sort tasks: processing first, then pending, then retrying, then completed/failed
  const sortedTasks = [...state.tasks].sort((a, b) => {
    const order = { processing: 0, pending: 1, retrying: 2, completed: 3, failed: 4 };
    const orderDiff = (order[a.state] ?? 5) - (order[b.state] ?? 5);
    if (orderDiff !== 0) return orderDiff;
    return b.createdAt - a.createdAt; // Newest first within same state
  });
  
  elements.taskList.innerHTML = sortedTasks.map(renderTaskCard).join('');
}

/**
 * Render a single task card
 */
function renderTaskCard(task) {
  const statusClass = task.state;
  const statusText = task.state.charAt(0).toUpperCase() + task.state.slice(1);
  
  let metaHtml = '';
  let progressHtml = '';
  let resultHtml = '';
  let retryHtml = '';
  let errorHtml = '';
  
  // Add meta info based on state
  switch (task.state) {
    case 'pending':
      const waitTime = formatDuration(task.estimatedWaitTime || 0);
      metaHtml = `<div class="task-meta">Estimated wait: ~${waitTime}</div>`;
      break;
      
    case 'processing':
      const elapsed = formatDuration(Date.now() - task.startedAt);
      progressHtml = `
        <div class="progress-container">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${task.progress || 0}%"></div>
          </div>
          <div class="progress-text">
            <span class="progress-percent">${task.progress || 0}%</span>
            <span>${elapsed} elapsed</span>
          </div>
        </div>
      `;
      break;
      
    case 'retrying':
      const nextRetry = task.nextRetryAt ? formatDuration(task.nextRetryAt - Date.now()) : 'soon';
      retryHtml = `
        <div class="retry-info">
          Retry ${task.retryCount}/${task.maxRetries} in ~${nextRetry}
          ${task.error ? `<br>Last error: ${task.error.message}` : ''}
        </div>
      `;
      break;
      
    case 'completed':
      const processingTime = task.result?.processingTime 
        ? formatDuration(task.result.processingTime) 
        : formatDuration(task.completedAt - task.startedAt);
      metaHtml = `<div class="task-meta">Completed in ${processingTime}</div>`;
      
      if (task.result?.imageUrl) {
        resultHtml = `
          <div class="task-result">
            <img src="${task.result.imageUrl}" alt="Generated image" class="result-image" loading="lazy">
            <a href="${task.result.imageUrl}" target="_blank" class="result-link">Open full image ↗</a>
          </div>
        `;
      }
      break;
      
    case 'failed':
      errorHtml = `
        <div class="error-info">
          ${task.error?.message || 'Unknown error'}
          ${task.retryCount > 0 ? `<br>Failed after ${task.retryCount} retries` : ''}
        </div>
      `;
      break;
  }
  
  return `
    <div class="task-card ${statusClass}" data-task-id="${task.id}">
      <div class="task-header">
        <span class="task-status ${statusClass}">${statusText}</span>
        <span class="task-id">${task.id}</span>
      </div>
      <div class="task-prompt">"${escapeHtml(task.prompt)}"</div>
      ${metaHtml}
      ${progressHtml}
      ${retryHtml}
      ${errorHtml}
      ${resultHtml}
    </div>
  `;
}

// ============================================
// Utilities
// ============================================

/**
 * Format milliseconds as human-readable duration
 */
function formatDuration(ms) {
  if (ms < 0) return '0s';
  
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  
  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }
  
  return `${seconds}s`;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================
// Update retry countdowns
// ============================================

/**
 * Update countdown timers for retrying tasks
 * Runs every second to keep "retry in X seconds" accurate
 */
function startRetryCountdownUpdater() {
  setInterval(() => {
    const retryingTasks = state.tasks.filter(t => t.state === 'retrying');
    if (retryingTasks.length > 0) {
      renderTaskList(); // Re-render to update countdown
    }
  }, 1000);
}

// ============================================
// Initialize
// ============================================

function init() {
  // Connect to SSE
  connectSSE();
  
  // Form submission
  elements.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const prompt = elements.promptInput.value.trim();
    if (prompt) {
      submitTask(prompt);
    }
  });
  
  // Start retry countdown updater
  startRetryCountdownUpdater();
  
  console.log('[UI] Task Queue initialized');
}

// Start the app
init();