/**
 * Task Worker
 * 
 * The worker is the engine that processes tasks from the queue.
 * It runs continuously, picking up pending tasks and executing them.
 * 
 * KEY CONCEPTS:
 * - Continuous processing loop
 * - Concurrency management
 * - Graceful error handling
 * - Retry coordination
 * 
 * NOTE: Uses Pollinations.ai - completely FREE, no API key needed!
 */

const queueManager = require('./queue');
const PollinationsClient = require('./pollinations');

class Worker {
  constructor() {
    // Pollinations is always available - no API key required!
    this.pollinations = new PollinationsClient();
    this.isRunning = false;
    this.processingLoop = null;
    this.retryLoop = null;
  }

  /**
   * Initialize the worker
   * No API key needed for Pollinations - it's free!
   */
  initialize() {
    console.log('[Worker] Pollinations.ai client initialized (FREE - no API key needed)');
  }

  /**
   * Start the worker loops
   * 
   * We have two loops:
   * 1. Main processing loop - picks up pending tasks
   * 2. Retry loop - checks for tasks ready to retry
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log('[Worker] Started');

    // Main processing loop - runs every 500ms
    this.processingLoop = setInterval(() => {
      this.processNextTask();
    }, 500);

    // Retry loop - runs every 5 seconds
    // WHY SEPARATE LOOP: Retry checking doesn't need to run as frequently.
    // We check every 5 seconds to see if any retries are due.
    this.retryLoop = setInterval(() => {
      this.checkRetries();
    }, 5000);
  }

  /**
   * Stop the worker
   */
  stop() {
    this.isRunning = false;
    if (this.processingLoop) {
      clearInterval(this.processingLoop);
      this.processingLoop = null;
    }
    if (this.retryLoop) {
      clearInterval(this.retryLoop);
      this.retryLoop = null;
    }
    console.log('[Worker] Stopped');
  }

  /**
   * Try to process the next pending task
   * 
   * This is called every 500ms by the processing loop.
   * It checks if we have capacity and a pending task to process.
   */
  async processNextTask() {
    // Check if we have capacity
    if (!queueManager.hasCapacity()) {
      return; // All slots are busy
    }

    // Get next pending task
    const task = queueManager.getNextPendingTask();
    if (!task) {
      return; // No pending tasks
    }

    // Start processing
    console.log(`[Task] Processing ${task.id}: "${task.prompt.substring(0, 50)}..."`);
    queueManager.startProcessing(task.id);

    try {
      // Generate image using Pollinations (free!)
      const result = await this.pollinations.generateImage(
        task.prompt,
        (progress) => queueManager.updateProgress(task.id, progress)
      );

      // Success!
      console.log(`[Task] ${task.id} completed successfully`);
      queueManager.completeTask(task.id, result);

    } catch (error) {
      // Failure - let queue manager handle retry logic
      console.error(`[Task] ${task.id} failed:`, error.message);
      
      const isRetryable = error.isRetryable !== undefined ? error.isRetryable : true;
      queueManager.failTask(task.id, error, isRetryable);
    }
  }

  /**
   * Check for tasks ready to retry
   * 
   * This runs every 5 seconds. It looks for tasks in 'retrying' state
   * whose nextRetryAt has passed, and moves them back to pending.
   */
  checkRetries() {
    const tasksToRetry = queueManager.getTasksReadyForRetry();

    for (const task of tasksToRetry) {
      console.log(`[Task] Requeuing ${task.id} for retry (attempt ${task.retryCount + 1})`);
      queueManager.requeueForRetry(task.id);
    }
  }
}

// Singleton instance
const worker = new Worker();

module.exports = worker;