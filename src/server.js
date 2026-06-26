const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const path = require('path');
const { redis, redisSub } = require('./redis');

dotenv.config();

const app = express();
const port = process.env.API_PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static files from src/public
app.use(express.static(path.join(__dirname, 'public')));

// Middleware for Sliding Expiration
// If a request provides a Session ID, refresh its TTL in Redis and update lastActive
app.use(async (req, res, next) => {
  try {
    const sessionId = req.headers['x-session-id'] || req.query.sessionId;
    if (sessionId) {
      const sessionKey = `session:${sessionId}`;
      const exists = await redis.exists(sessionKey);
      if (exists) {
        const now = new Date().toISOString();
        await redis.hset(sessionKey, 'lastActive', now);
        await redis.expire(sessionKey, 1800); // 30-minute sliding expiration
      }
    }
  } catch (err) {
    console.error('Error in sliding expiration middleware:', err);
  }
  next();
});

// 1. Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

// 2. Create User Session
// POST /api/sessions
// Request body: { userId, ipAddress, deviceType }
app.post('/api/sessions', async (req, res) => {
  try {
    const { userId, ipAddress, deviceType } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const sessionId = crypto.randomUUID();
    const sessionKey = `session:${sessionId}`;
    const userSessionsKey = `user_sessions:${userId}`;
    const now = new Date().toISOString();
    const ttl = 1800; // 30 minutes in seconds

    // Call atomic Lua script to invalidate old sessions and create new one
    await redis.invalidateAndCreateSession(
      userSessionsKey,
      sessionKey,
      userId,
      sessionId,
      ipAddress || '127.0.0.1',
      deviceType || 'unknown',
      now,
      now,
      ttl
    );

    res.status(201).json({ sessionId });
  } catch (err) {
    console.error('Failed to create session:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Submit Score Directly
// POST /api/leaderboard/scores
// Request body: { playerId, points }
app.post('/api/leaderboard/scores', async (req, res) => {
  try {
    const { playerId, points } = req.body;
    if (!playerId || points === undefined) {
      return res.status(400).json({ error: 'playerId and points are required' });
    }

    const pointsNum = parseInt(points, 10);
    if (isNaN(pointsNum)) {
      return res.status(400).json({ error: 'points must be a valid number' });
    }

    // Increment player's score atomically using ZINCRBY
    const newScoreRaw = await redis.zincrby('leaderboard:global', pointsNum, playerId);
    const newScore = parseFloat(newScoreRaw);

    // Publish event via Redis Pub/Sub
    const eventPayload = {
      event: 'leaderboard_updated',
      data: { playerId, newScore }
    };
    await redis.publish('game-events', JSON.stringify(eventPayload));

    res.status(200).json({ playerId, newScore });
  } catch (err) {
    console.error('Failed to update leaderboard score:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Query Leaderboard Top Players
// GET /api/leaderboard/top/{count}
app.get('/api/leaderboard/top/:count', async (req, res) => {
  try {
    const count = parseInt(req.params.count, 10);
    if (isNaN(count) || count <= 0) {
      return res.status(400).json({ error: 'count must be a positive integer' });
    }

    // Get top count players with scores
    const raw = await redis.zrevrange('leaderboard:global', 0, count - 1, 'WITHSCORES');
    const topPlayers = [];
    for (let i = 0; i < raw.length; i += 2) {
      topPlayers.push({
        rank: (i / 2) + 1,
        playerId: raw[i],
        score: parseFloat(raw[i + 1])
      });
    }

    res.status(200).json(topPlayers);
  } catch (err) {
    console.error('Failed to get top leaderboard:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 5. Query Player Rank and Context
// GET /api/leaderboard/player/{playerId}
app.get('/api/leaderboard/player/:playerId', async (req, res) => {
  try {
    const { playerId } = req.params;

    // Check if player exists on global leaderboard
    const scoreRaw = await redis.zscore('leaderboard:global', playerId);
    if (scoreRaw === null) {
      return res.status(404).json({ status: 'ERROR', code: 'PLAYER_NOT_FOUND', message: 'Player does not exist on leaderboard' });
    }

    const score = parseFloat(scoreRaw);
    const zrevRank = await redis.zrevrank('leaderboard:global', playerId);
    const rank = zrevRank + 1;
    const totalPlayers = await redis.zcard('leaderboard:global');

    // Calculate Percentile: percentage of players below or equal to player
    // Formula: ((totalPlayers - rank + 1) / totalPlayers) * 100
    // e.g. rank 10 out of 200 players: ((200 - 10 + 1) / 200) * 100 = (191 / 200) * 100 = 95.5%
    const percentile = totalPlayers > 0
      ? parseFloat((((totalPlayers - rank + 1) / totalPlayers) * 100).toFixed(2))
      : 100.0;

    // Retrieve nearby players above (indices zrevRank-2 to zrevRank-1)
    const startAbove = Math.max(0, zrevRank - 2);
    const endAbove = zrevRank - 1;
    const above = [];
    if (endAbove >= startAbove) {
      const aboveRaw = await redis.zrevrange('leaderboard:global', startAbove, endAbove, 'WITHSCORES');
      for (let i = 0; i < aboveRaw.length; i += 2) {
        above.push({
          rank: startAbove + (i / 2) + 1,
          playerId: aboveRaw[i],
          score: parseFloat(aboveRaw[i + 1])
        });
      }
    }

    // Retrieve nearby players below (indices zrevRank+1 to zrevRank+2)
    const startBelow = zrevRank + 1;
    const endBelow = zrevRank + 2;
    const below = [];
    const belowRaw = await redis.zrevrange('leaderboard:global', startBelow, endBelow, 'WITHSCORES');
    for (let i = 0; i < belowRaw.length; i += 2) {
      below.push({
        rank: startBelow + (i / 2) + 1,
        playerId: belowRaw[i],
        score: parseFloat(belowRaw[i + 1])
      });
    }

    res.status(200).json({
      playerId,
      score,
      rank,
      percentile,
      nearbyPlayers: {
        above,
        below
      }
    });
  } catch (err) {
    console.error('Failed to get player leaderboard context:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 6. Submit Quiz Answer
// POST /api/game/submit
// Request body: { gameId, roundId, playerId, answer }
app.post('/api/game/submit', async (req, res) => {
  try {
    const { gameId, roundId, playerId, answer } = req.body;
    if (!gameId || !roundId || !playerId || answer === undefined) {
      return res.status(400).json({ error: 'gameId, roundId, playerId, and answer are required' });
    }

    const roundKey = `game_round:${gameId}:${roundId}`;
    const submissionsKey = `submissions:${gameId}:${roundId}`;
    const globalLeaderboardKey = `leaderboard:global`;
    const gameLeaderboardKey = `leaderboard:game:${gameId}`;
    const currentTime = Date.now();

    // Call Lua script for atomic answer validation and submission
    const result = await redis.submitRoundAnswer(
      roundKey,
      submissionsKey,
      globalLeaderboardKey,
      gameLeaderboardKey,
      playerId,
      answer,
      currentTime
    );

    const [status, val1, val2] = result;

    if (status === 'error') {
      if (val1 === 'ROUND_NOT_FOUND' || val1 === 'ROUND_EXPIRED') {
        return res.status(403).json({ status: 'ERROR', code: 'ROUND_EXPIRED' });
      }
      if (val1 === 'DUPLICATE_SUBMISSION') {
        return res.status(400).json({ status: 'ERROR', code: 'DUPLICATE_SUBMISSION' });
      }
      return res.status(400).json({ status: 'ERROR', code: val1 });
    }

    const newScore = parseFloat(val1);
    const pointsAwarded = parseFloat(val2);

    // If correct (pointsAwarded > 0), publish to SSE channel
    if (pointsAwarded > 0) {
      const eventPayload = {
        event: 'leaderboard_updated',
        data: { playerId, newScore }
      };
      await redis.publish('game-events', JSON.stringify(eventPayload));
    }

    res.status(200).json({
      status: 'SUCCESS',
      newScore,
      pointsAwarded // Include custom utility field
    });
  } catch (err) {
    console.error('Failed to submit answer:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 7. SSE Events endpoint
// GET /api/events
// Content-Type: text/event-stream
let sseClients = [];

// Subscribe the static pubsub client to game-events
redisSub.subscribe('game-events', (err) => {
  if (err) {
    console.error('Failed to subscribe to game-events in SSE server:', err);
  } else {
    console.log('SSE Pub/Sub successfully subscribed to game-events.');
  }
});

// Listen for messages and forward them to SSE connections
redisSub.on('message', (channel, message) => {
  if (channel === 'game-events') {
    try {
      const parsed = JSON.parse(message);
      sseClients.forEach((client) => {
        client.res.write(`event: ${parsed.event}\n`);
        client.res.write(`data: ${JSON.stringify(parsed.data)}\n\n`);
      });
    } catch (err) {
      console.error('Error forwarding message through SSE:', err);
    }
  }
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write(':ok\n\n');

  const clientId = crypto.randomUUID();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  req.on('close', () => {
    sseClients = sseClients.filter((client) => client.id !== clientId);
  });
});

// 8. Admin Sessions for user
// GET /api/admin/sessions/user/{userId}
app.get('/api/admin/sessions/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const sessionIds = await redis.smembers(`user_sessions:${userId}`);
    const activeSessions = [];

    for (const sessionId of sessionIds) {
      const sessionKey = `session:${sessionId}`;
      const data = await redis.hgetall(sessionKey);

      // Verify that the hash actually exists (has fields)
      if (data && Object.keys(data).length > 0) {
        const ttl = await redis.ttl(sessionKey);
        activeSessions.push({
          sessionId,
          ipAddress: data.ipAddress || '',
          lastActive: data.lastActive || '',
          deviceType: data.deviceType || '',
          createdAt: data.createdAt || '',
          userId: data.userId || '',
          ttl
        });
      } else {
        // Lazy clean up expired session from index set
        await redis.srem(`user_sessions:${userId}`, sessionId);
      }
    }

    res.status(200).json(activeSessions);
  } catch (err) {
    console.error('Failed to query user sessions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 9. Admin delete session
// DELETE /api/admin/sessions/{sessionId}
app.delete('/api/admin/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionKey = `session:${sessionId}`;
    
    // Retrieve userId to remove session from user_sessions set
    const userId = await redis.hget(sessionKey, 'userId');

    if (userId) {
      const multi = redis.multi();
      multi.del(sessionKey);
      multi.srem(`user_sessions:${userId}`, sessionId);
      await multi.exec();
    } else {
      await redis.del(sessionKey);
    }

    res.status(204).end();
  } catch (err) {
    console.error('Failed to delete session:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 10. Admin endpoint to seed a round (Utility for Frontend / Testing)
// POST /api/admin/rounds
// Request body: { gameId, roundId, durationSeconds, correctAnswer, points }
app.post('/api/admin/rounds', async (req, res) => {
  try {
    const { gameId, roundId, durationSeconds, correctAnswer, points } = req.body;
    if (!gameId || !roundId || !durationSeconds || !correctAnswer || points === undefined) {
      return res.status(400).json({ error: 'gameId, roundId, durationSeconds, correctAnswer, and points are required' });
    }

    const roundKey = `game_round:${gameId}:${roundId}`;
    const duration = parseInt(durationSeconds, 10);
    const endTime = Date.now() + duration * 1000;
    const pointsVal = parseInt(points, 10);

    const multi = redis.multi();
    multi.hset(roundKey, {
      endTime: endTime.toString(),
      correctAnswer: correctAnswer,
      points: pointsVal.toString()
    });
    // Expire the round state structure after it is completed plus buffer time
    multi.expire(roundKey, duration + 300);
    
    // Also reset submissions for this round to make it fresh
    multi.del(`submissions:${gameId}:${roundId}`);
    
    await multi.exec();

    res.status(201).json({
      message: 'Round seeded successfully',
      roundKey,
      endTime,
      correctAnswer,
      points: pointsVal
    });
  } catch (err) {
    console.error('Failed to seed round:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`API Server running on port ${port}`);
});
