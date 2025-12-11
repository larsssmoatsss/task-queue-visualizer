/**
 * Express Server
 * 
 * The HTTP interface for our task queue system.
 * Handles task submission, status queries, and SSE streaming.
 * 
 * KEY CONCEPTS:
 * - RESTful API design
 * - Server-Sent Events (SSE) for real-time updates
 * - CORS for cross-origin requests
 * - Static file serving
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const queueManager = require('./queue');
const worker = require('./worker');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../frontend')));

// ============================================
// API Routes
// ============================================

/**
 * POST /tasks
 * Submit a new image generation task
 * 
 * Request: { prompt: "a cat wearing sunglasses" }
 * Response: { id, prompt, state, estimatedWaitTime, ... }
 */
app.post('/tasks', (req, res) => {
  try {
    const { prompt } = req.body;

    // Validate input
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Prompt is required and must be a non-empty string'
      });
    }

    if (prompt.length > 1000) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Prompt must be 1000 characters or less'
      });
    }

    // Create the task
    const task = queueManager.createTask(prompt);

    console.log(`[Task] New task submitted: ${task.id}`);

    res.status(201).json(task);

  } catch (error) {
    console.error('Error creating task:', error.message);

    if (error.message.includes('Queue full')) {
      return res.status(503).json({
        error: 'Queue full',
        message: 'The queue is at capacity. Please wait for some tasks to complete.'
      });
    }

    res.status(500).json({
      error: 'Internal error',
      message: 'Failed to create task'
    });
  }
});

/**
 * GET /tasks
 * Get all tasks (for initial state load)
 */
app.get('/tasks', (req, res) => {
  const tasks = queueManager.getAllTasks();
  res.json(tasks);
});

/**
 * GET /tasks/:id
 * Get a specific task by ID
 */
app.get('/tasks/:id', (req, res) => {
  const task = queueManager.getTask(req.params.id);

  if (!task) {
    return res.status(404).json({
      error: 'Not found',
      message: 'Task not found'
    });
  }

  res.json(task);
});

/**
 * DELETE /tasks/:id
 * Cancel a pending task
 */
app.delete('/tasks/:id', (req, res) => {
  const success = queueManager.cancelTask(req.params.id);

  if (!success) {
    return res.status(400).json({
      error: 'Cannot cancel',
      message: 'Task not found or cannot be canceled (may be processing)'
    });
  }

  res.json({ success: true, message: 'Task canceled' });
});

/**
 * GET /stats
 * Get queue statistics
 */
app.get('/stats', (req, res) => {
  res.json(queueManager.getStats());
});

// ============================================
// Server-Sent Events (SSE) Endpoint
// ============================================

/**
 * GET /queue/stream
 * Real-time queue updates via Server-Sent Events
 * 
 * WHY SSE (not WebSocket)?
 * - Simpler to implement
 * - Built-in browser reconnection
 * - Sufficient for one-way updates (server → client)
 * - Standard HTTP, works with proxies/load balancers
 * 
 * SSE sends a stream of events. Each event has:
 * - event: <type> (task_submitted, task_completed, etc.)
 * - data: <json>
 * 
 * The browser's EventSource API handles:
 * - Connection management
 * - Automatic reconnection
 * - Event parsing
 */
app.get('/queue/stream', (req, res) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Send initial comment to establish connection
  res.write(':ok\n\n');

  // Register this client with the queue manager
  // The queue manager will push updates to all connected clients
  queueManager.addSSEClient(res);

  console.log(`[SSE] Client connected (${queueManager.sseClients.size} total)`);

  // Handle client disconnect
  req.on('close', () => {
    console.log(`[SSE] Client disconnected (${queueManager.sseClients.size} total)`);
  });
});

// ============================================
// Health Check
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    queue: queueManager.getStats()
  });
});

// ============================================
// Start Server
// ============================================

app.listen(PORT, () => {
  console.log(`
+-------------------------------------------------------+
|                                                       |
|   Image Generation Task Queue                         |
|   ---------------------------------------------------  |
|   Server running on http://localhost:${PORT}            |
|                                                       |
|   API Endpoints:                                      |
|   - POST /tasks      - Submit new task                |
|   - GET  /tasks      - List all tasks                 |
|   - GET  /tasks/:id  - Get specific task              |
|   - DELETE /tasks/:id - Cancel task                   |
|   - GET  /stats      - Queue statistics               |
|   - GET  /queue/stream - Real-time SSE updates        |
|                                                       |
+-------------------------------------------------------+
  `);

  // Initialize and start the worker (no API key needed - Pollinations is free!)
  worker.initialize();
  worker.start();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  worker.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  worker.stop();
  process.exit(0);
});