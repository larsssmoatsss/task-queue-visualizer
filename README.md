# Task Queue with Retry Logic

A self-contained image generation task queue demonstrating enterprise backend patterns: **async task processing**, **exponential backoff retries**, **real-time updates via SSE**, and **graceful error handling**.

**100% FREE - No API key needed!** Uses [Pollinations.ai](https://pollinations.ai) for image generation.

## What This Teaches

This project demonstrates the exact patterns used in production systems at scale:

| Concept | What It Means | Where It's Used |
|---------|---------------|-----------------|
| **Async Task Processing** | Tasks don't block each other; processed independently | Payment processing, email systems |
| **Queue Management** | FIFO processing with concurrency limits | Job schedulers (Celery, Bull, SQS) |
| **Exponential Backoff** | Wait longer between retries: 2s → 4s → 8s → 16s | AWS SDK, Google Cloud, Stripe |
| **Error Classification** | Distinguish retryable vs permanent failures | Any resilient API client |
| **Real-Time Updates** | SSE streams state changes to clients | Dashboards, monitoring tools |
| **Backpressure** | Reject requests when queue is full | Rate limiting, load shedding |

Understanding these patterns means understanding how modern distributed systems work.

## Quick Start

```bash
# Install dependencies
npm install

# Run the server (no API key needed!)
npm start

# Open browser
open http://localhost:3000
```

That's it! The app uses **Pollinations.ai** which is completely free with no signup required.

## How It Works

### The Queue Flow

```
User submits prompt
       ↓
Task added to queue (state: "pending")
       ↓
Worker picks up task when capacity available
       ↓
Task state: "processing"
       ↓
Call Replicate API → Poll until complete
       ↓
┌──────────────────┬───────────────────┐
│ Success          │ Failure           │
├──────────────────┼───────────────────┤
│ state: completed │ Is it retryable?  │
│ Store image URL  │ Yes → retry later │
│                  │ No → final fail   │
└──────────────────┴───────────────────┘
```

### Key Mechanics

**Concurrency Limiting**: Max 5 tasks process simultaneously (respecting API limits)

**Exponential Backoff**: Failed tasks retry with increasing delays
```
Attempt 1 fails → wait 2s
Attempt 2 fails → wait 4s  
Attempt 3 fails → wait 8s
Attempt 4 fails → wait 16s
Attempt 5 fails → give up
```

**Error Classification**:
- **Retryable**: Timeouts, 429 (rate limit), 5xx (server errors)
- **Permanent**: 400 (bad input), 401 (bad auth), 404 (not found)

**Real-Time Updates**: Server-Sent Events stream state changes instantly

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/tasks` | Submit new task |
| GET | `/tasks` | List all tasks |
| GET | `/tasks/:id` | Get specific task |
| DELETE | `/tasks/:id` | Cancel pending task |
| GET | `/stats` | Queue statistics |
| GET | `/queue/stream` | SSE stream (real-time updates) |

## Testing Scenarios

### Basic Flow
1. Submit a prompt
2. Watch it move: pending → processing → completed
3. See the generated image

### Retry Logic
1. Submit prompt containing "fail permanently" (triggers mock permanent failure)
2. Submit several normal prompts
3. ~10% will randomly fail and auto-retry with backoff
4. Watch the retry countdown in the UI

### Queue Limits
1. Submit 100+ prompts rapidly
2. See "Queue full" error after 100
3. Watch new submissions accepted as tasks complete

### Concurrent Processing
1. Submit 10 prompts quickly
2. Observe max 5 processing simultaneously
3. Watch tasks complete in batches

## Project Structure

```
task-queue-app/
├── frontend/
│   ├── index.html      # Queue visualization UI
│   ├── styles.css      # Dashboard styling
│   └── app.js          # SSE handling, state management
├── backend/
│   ├── server.js       # Express + SSE endpoint
│   ├── queue.js        # QueueManager class (the brain)
│   ├── worker.js       # Task processing loop
│   └── replicate.js    # Pollinations.ai API client (FREE!)
├── package.json
├── .env.example
└── README.md
```

## Key Code Concepts

### Exponential Backoff (queue.js)
```javascript
calculateBackoff(retryCount) {
  // Formula: baseDelay * 2^(attempt-1)
  const exponentialDelay = 2000 * Math.pow(2, retryCount - 1);
  const cappedDelay = Math.min(exponentialDelay, 60000);
  
  // Jitter prevents "thundering herd"
  const jitter = cappedDelay * 0.25 * (Math.random() - 0.5);
  
  return Math.floor(cappedDelay + jitter);
}
```

### SSE Broadcasting (queue.js)
```javascript
broadcast(event, data) {
  // Push update to ALL connected clients
  for (const client of this.sseClients) {
    client.write(`event: ${event}\n`);
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
```

### Error Classification (replicate.js)
```javascript
isRetryableStatusCode(statusCode) {
  // 5xx = server error (temporary)
  // 429 = rate limited (back off)
  const retryableCodes = [429, 500, 502, 503, 504];
  return retryableCodes.includes(statusCode);
  
  // 4xx = client error (won't work no matter how many times we retry)
}
```

## Why This Matters

These aren't academic patterns—they're how real systems work:

- **Stripe** queues payment processing with automatic retries
- **AWS SQS** uses exponential backoff by default
- **Celery/Bull** implement these exact queue mechanics
- **Every major API client** classifies errors for retry decisions

Building this project gives you hands-on understanding of concepts you'll encounter in any serious backend role.

## Next Steps

Ideas for extending this project:

1. **Persistent Storage**: Add SQLite/Postgres to survive restarts
2. **Priority Queues**: VIP tasks jump ahead
3. **Dead Letter Queue**: Store permanently failed tasks for review
4. **Rate Limiting**: Per-user submission limits
5. **WebSocket**: Two-way communication for cancellation
6. **Metrics**: Track success rates, average processing time
7. **Multiple Workers**: Scale across processes

## License

MIT - Use this to learn, build, and demonstrate your skills!