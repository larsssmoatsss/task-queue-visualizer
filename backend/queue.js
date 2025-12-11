/**
 * Task Queue Manager
 * 
 * This is the heart of the system - managing task state, enforcing
 * concurrency limits, and coordinating with SSE for real-time updates.
 * 
 * KEY CONCEPTS DEMONSTRATED:
 * - FIFO queue processing
 * - Concurrency limiting (max 5 concurrent API calls)
 * - State machine (pending → processing → completed/failed)
 * - Event-driven updates (broadcast changes to all connected clients)
 */

const { v4: uuidv4 } = require('uuid');

class QueueManager {
  constructor() {
    // In-memory task storage - in production you'd use Redis or a database
    this.tasks = new Map();
    
    // Track how many tasks are currently being processed
    // This is how we respect Replicate's 5-concurrent-request limit
    this.currentlyProcessing = 0;
    this.MAX_CONCURRENT = 5;
    
    // Queue limits to prevent memory exhaustion
    this.MAX_QUEUE_SIZE = 100;
    
    // SSE clients - we'll broadcast updates to all connected clients
    this.sseClients = new Set();
    
    // Retry configuration
    this.BASE_RETRY_DELAY = 2000; // 2 seconds
    this.MAX_RETRY_DELAY = 60000; // 60 seconds max
    this.MAX_RETRIES = 5;
  }

  /**
   * Add a new task to the queue
   * 
   * WHY WE RETURN IMMEDIATELY: The user doesn't wait for the image to generate.
   * They get a task ID back instantly, and can track progress via SSE.
   * This is async task processing - the foundation of scalable systems.
   */
  createTask(prompt) {
    // Enforce queue limits - this is "backpressure"
    // Without limits, a flood of requests would exhaust memory
    if (this.tasks.size >= this.MAX_QUEUE_SIZE) {
      throw new Error('Queue full - please wait for some tasks to complete');
    }

    const task = {
      id: `task_${uuidv4().slice(0, 8)}`,
      prompt: prompt.trim(),
      state: 'pending',
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      retryCount: 0,
      maxRetries: this.MAX_RETRIES,
      nextRetryAt: null,
      progress: 0
    };

    // Calculate estimated wait time based on queue position
    task.estimatedWaitTime = this.calculateEstimatedWait();

    this.tasks.set(task.id, task);
    
    // Broadcast to all SSE clients that a new task was added
    this.broadcast('task_submitted', task);
    this.broadcastStats();

    return task;
  }

  /**
   * Get the next pending task for processing
   * 
   * WHY FIFO: First-In-First-Out is fair - tasks are processed in submission order.
   * Alternative orderings (priority queues, LIFO) exist but FIFO is most intuitive.
   */
  getNextPendingTask() {
    // Find the oldest pending task (FIFO)
    let oldestPending = null;
    for (const task of this.tasks.values()) {
      if (task.state === 'pending') {
        if (!oldestPending || task.createdAt < oldestPending.createdAt) {
          oldestPending = task;
        }
      }
    }
    return oldestPending;
  }

  /**
   * Check if we have capacity to process another task
   * 
   * WHY LIMIT CONCURRENCY: Replicate's API allows max 5 concurrent predictions.
   * If we exceed this, we'll get rate-limited (429 errors).
   * By tracking concurrency ourselves, we avoid hammering the API.
   */
  hasCapacity() {
    return this.currentlyProcessing < this.MAX_CONCURRENT;
  }

  /**
   * Mark a task as processing
   */
  startProcessing(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.state = 'processing';
    task.startedAt = Date.now();
    task.progress = 0;
    this.currentlyProcessing++;

    this.broadcast('task_started', task);
    this.broadcastStats();

    return task;
  }

  /**
   * Update task progress (0-100)
   */
  updateProgress(taskId, progress) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.progress = Math.min(100, Math.max(0, progress));
    this.broadcast('task_progress', { id: taskId, progress: task.progress });
  }

  /**
   * Mark a task as completed successfully
   */
  completeTask(taskId, result) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.state = 'completed';
    task.completedAt = Date.now();
    task.result = result;
    task.progress = 100;
    this.currentlyProcessing--;

    this.broadcast('task_completed', task);
    this.broadcastStats();
    this.updateEstimatedWaitTimes();

    return task;
  }

  /**
   * Mark a task as failed and potentially schedule a retry
   * 
   * KEY INSIGHT: Not all errors are the same.
   * - Retryable: Server glitches, timeouts, rate limits (might work next time)
   * - Permanent: Invalid input, authentication failures (won't ever work)
   * 
   * Distinguishing these prevents wasting retries on hopeless cases.
   */
  failTask(taskId, error, isRetryable = true) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.error = {
      code: error.code || 'UNKNOWN',
      message: error.message || 'Unknown error occurred'
    };
    
    this.currentlyProcessing--;

    // Decide whether to retry
    const shouldRetry = isRetryable && task.retryCount < task.maxRetries;

    if (shouldRetry) {
      // Schedule retry with exponential backoff
      task.retryCount++;
      task.nextRetryAt = Date.now() + this.calculateBackoff(task.retryCount);
      task.state = 'retrying';

      this.broadcast('task_retry_scheduled', {
        id: taskId,
        retryCount: task.retryCount,
        maxRetries: task.maxRetries,
        nextRetryAt: task.nextRetryAt,
        error: task.error
      });
    } else {
      // Permanent failure - no more retries
      task.state = 'failed';
      task.completedAt = Date.now();

      this.broadcast('task_failed', task);
    }

    this.broadcastStats();
    return task;
  }

  /**
   * Calculate exponential backoff delay
   * 
   * WHY EXPONENTIAL BACKOFF:
   * If an API is struggling, hammering it with immediate retries makes things worse.
   * By waiting progressively longer (2s, 4s, 8s, 16s...), we give the API time to recover.
   * 
   * This is a CRITICAL pattern used in:
   * - AWS SDK (automatic retries)
   * - Google Cloud clients
   * - Payment processors (Stripe, etc.)
   * - Any resilient distributed system
   * 
   * Formula: delay = baseDelay * (2 ^ attemptNumber)
   * With jitter to prevent "thundering herd" (all clients retrying simultaneously)
   */
  calculateBackoff(retryCount) {
    const exponentialDelay = this.BASE_RETRY_DELAY * Math.pow(2, retryCount - 1);
    const cappedDelay = Math.min(exponentialDelay, this.MAX_RETRY_DELAY);
    
    // Add jitter (±25%) to prevent synchronized retries
    const jitter = cappedDelay * 0.25 * (Math.random() - 0.5);
    
    return Math.floor(cappedDelay + jitter);
  }

  /**
   * Check for tasks ready to retry
   * Called periodically by the worker
   */
  getTasksReadyForRetry() {
    const now = Date.now();
    const ready = [];

    for (const task of this.tasks.values()) {
      if (task.state === 'retrying' && task.nextRetryAt && now >= task.nextRetryAt) {
        ready.push(task);
      }
    }

    return ready;
  }

  /**
   * Move a task back to pending for retry
   */
  requeueForRetry(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.state = 'pending';
    task.nextRetryAt = null;
    task.error = null;

    this.broadcast('task_requeued', task);
    return task;
  }

  /**
   * Calculate estimated wait time for new tasks
   * 
   * This is a rough estimate: (tasks ahead * average processing time)
   * Real systems might use historical data for better predictions.
   */
  calculateEstimatedWait() {
    const AVERAGE_TASK_TIME = 30000; // 30 seconds average per task

    let pendingCount = 0;
    let processingCount = 0;

    for (const task of this.tasks.values()) {
      if (task.state === 'pending') pendingCount++;
      if (task.state === 'processing') processingCount++;
    }

    // Account for concurrent processing
    const effectiveQueueLength = pendingCount + Math.ceil(processingCount / this.MAX_CONCURRENT);
    return effectiveQueueLength * AVERAGE_TASK_TIME;
  }

  /**
   * Update estimated wait times for all pending tasks
   */
  updateEstimatedWaitTimes() {
    const AVERAGE_TASK_TIME = 30000;
    let position = 0;

    // Sort by creation time (FIFO order)
    const sortedTasks = [...this.tasks.values()]
      .filter(t => t.state === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const task of sortedTasks) {
      task.estimatedWaitTime = position * AVERAGE_TASK_TIME;
      position++;
    }
  }

  /**
   * Get task by ID
   */
  getTask(taskId) {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks (for full state sync)
   */
  getAllTasks() {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get queue statistics
   */
  getStats() {
    const stats = {
      pending: 0,
      processing: 0,
      retrying: 0,
      completed: 0,
      failed: 0,
      total: this.tasks.size
    };

    for (const task of this.tasks.values()) {
      stats[task.state]++;
    }

    return stats;
  }

  /**
   * Cancel a pending task
   */
  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.state === 'processing') {
      return false; // Can't cancel processing tasks
    }

    this.tasks.delete(taskId);
    this.broadcast('task_cancelled', { id: taskId });
    this.broadcastStats();
    return true;
  }

  // === SSE Client Management ===

  /**
   * Register an SSE client
   */
  addSSEClient(res) {
    this.sseClients.add(res);
    
    // Send initial state snapshot
    this.sendToClient(res, 'queue_snapshot', this.getAllTasks());
    this.sendToClient(res, 'queue_stats', this.getStats());

    // Remove client when connection closes
    res.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  /**
   * Send event to a single client
   */
  sendToClient(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * Broadcast event to all connected clients
   * 
   * WHY BROADCAST: When task state changes, ALL connected clients need to know.
   * This is the "pub/sub" pattern - clients subscribe, server publishes updates.
   */
  broadcast(event, data) {
    for (const client of this.sseClients) {
      this.sendToClient(client, event, data);
    }
  }

  /**
   * Broadcast current stats to all clients
   */
  broadcastStats() {
    this.broadcast('queue_stats', this.getStats());
  }
}

// Singleton instance
const queueManager = new QueueManager();

module.exports = queueManager;
