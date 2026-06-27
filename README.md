# TriviaBlast Live - Real-Time Redis Quiz Game Backend

A high-performance, production-ready real-time quiz game backend built with Node.js, Express, and Redis. This project showcases advanced Redis data structures (Hashes, Sets, Sorted Sets), atomic database transactions using Lua scripting, and a real-time event pipeline via Redis Pub/Sub and Server-Sent Events (SSE), complete with an interactive dashboard.

---

## 🚀 Features

- **Atomic Session Store**: Manages player sessions in Redis Hashes with a 30-minute sliding expiration. Atomically invalidates old sessions upon new login using a custom Lua script.
- **Real-Time Leaderboard**: Leverages Redis Sorted Sets (`ZSet`) to maintain player scores. Provides O(1) and O(log N) lookup speeds for top ranks, player ranks, percentiles, and nearby competitors.
- **Atomic Quiz Engine**: Utilizes an atomic Lua script to process quiz question submissions, verifying round window validity, preventing duplicate submissions, and updating leaderboards in a single database step.
- **SSE Broadcast Pipeline**: Publishes leaderboard updates to Redis Pub/Sub channels and broadcasts them to all active client streams via Server-Sent Events (SSE).
- **Interactive Dashboard**: A glassmorphic, responsive frontend dashboard to create sessions, submit scores, run quiz rounds, and perform admin lookups.

---

## 🛠️ Tech Stack

- **Core**: Node.js (v22), Express.js
- **Database**: Redis (v7.0 Alpine)
- **Containerization**: Docker, Docker Compose
- **Real-time Stream**: Server-Sent Events (SSE), Redis Pub/Sub
- **Frontend**: Vanilla HTML5, CSS3 (Glassmorphism + Neon theme), JS ES6

---

## 📂 Project Structure

```
├── src/
│   ├── public/              # Frontend Dashboard files
│   │   ├── index.html       # Dashboard Structure
│   │   ├── style.css        # Rich Glassmorphic Styling
│   │   └── app.js           # Frontend Logic & SSE Event handling
│   ├── redis.js             # Redis client and atomic Lua scripts definition
│   ├── server.js            # Express routes and Server-Sent Events pipeline
│   └── bench.js             # Benchmark and memory analysis scripts
├── Dockerfile               # Node.js alpine docker build
├── docker-compose.yml       # Services orchestration
├── .env.example             # Environment templates
├── MEMORY_ANALYSIS.md       # Benchmark reports and key encodings
├── submission.json          # Automated testing configuration
└── README.md                # Project documentation
```

---

## ⚙️ Setup & Installation

### Prerequisites
Make sure you have [Docker](https://www.docker.com/) and [Docker Compose](https://docs.docker.com/compose/) installed on your machine.

### Running with Docker (Recommended)
1. Clone the repository and navigate to its root.
2. Build and start all services (API & Redis) with one command:
   ```bash
   docker-compose up --build
   ```
3. Once started, both containers will perform health checks. You can access the Interactive Dashboard in your browser at:
   ```
   http://localhost:3000
   ```

### Running Locally
To run the server locally (requires a running Redis server at `localhost:6379`):
1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the environment variables:
   ```bash
   cp .env.example .env
   ```
3. Start the application in development mode:
   ```bash
   npm run start
   ```

---

## 🧠 Redis Lua Scripting & Atomicity

To guarantee high performance and avoid race conditions under heavy concurrent loads, we leverage Redis Lua scripting (`EVAL`).

### 1. Session Creation & Invalidation Lua Script
When a user logs in, we must invalidate all of their active sessions and register the new one. 

**Why Lua over MULTI/EXEC?**
If we used regular Redis transactions, we would have to query the Set of session IDs `user_sessions:{userId}`, download them to our application server, loop through them to send `DEL` requests, and then run `SADD` and `HSET`. If another login request happens during this window, we would get race conditions (partially deleted sessions or stale index items).
By running this inside a Lua script, Redis executes all steps sequentially as a single block.

```lua
local user_sessions_key = KEYS[1]
local new_session_key = KEYS[2]
local userId = ARGV[1]
local sessionId = ARGV[2]
local ipAddress = ARGV[3]
local deviceType = ARGV[4]
local createdAt = ARGV[5]
local lastActive = ARGV[6]
local ttl = tonumber(ARGV[7])

-- Get all old session IDs for the user
local old_sessions = redis.call('SMEMBERS', user_sessions_key)

-- Delete old session hashes
for _, old_sess_id in ipairs(old_sessions) do
  redis.call('DEL', 'session:' .. old_sess_id)
end

-- Clear user sessions index set
redis.call('DEL', user_sessions_key)

-- Register new session ID in index set
redis.call('SADD', user_sessions_key, sessionId)

-- Create new session hash
redis.call('HSET', new_session_key,
  'userId', userId,
  'ipAddress', ipAddress,
  'deviceType', deviceType,
  'createdAt', createdAt,
  'lastActive', lastActive
)

-- Set expiration
redis.call('EXPIRE', new_session_key, ttl)

return "OK"
```

### 2. Atomic Quiz Submission Lua Script
When a player submits an answer to a question, we verify several checks and update points.

**Why Lua over MULTI/EXEC?**
Under high concurrency, two requests from the same player could arrive at the same time. If we perform the checks in Node.js, both might see that `SISMEMBER submissions:...` is false, and reward the player twice. 
The Lua script ensures that:
1. We check if the round is still active (`currentTime < round.endTime`).
2. We verify the player hasn't already submitted (`SISMEMBER`).
3. We record the submission (`SADD`).
4. We validate the answer and increment the player's score (`ZINCRBY`) if correct.
All these operations run atomically on the Redis thread in a single trip.

---

## 📊 Memory Benchmarks
For a detailed analysis of memory footprints, encodings, and performance trade-offs, please read the [Memory Analysis Report](MEMORY_ANALYSIS.md).
```bash
# To run the memory benchmark script on your local machine:
npm run seed-bench
```
