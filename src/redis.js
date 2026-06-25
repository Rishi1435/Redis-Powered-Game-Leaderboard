const Redis = require('ioredis');
const dotenv = require('dotenv');

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Main client for general operations
const redis = new Redis(redisUrl);

// Separate client for pub/sub subscriptions
const redisSub = new Redis(redisUrl);

redis.on('connect', () => console.log('Redis connected successfully.'));
redis.on('error', (err) => console.error('Redis connection error:', err));

redisSub.on('connect', () => console.log('Redis Subscriber connected successfully.'));
redisSub.on('error', (err) => console.error('Redis Subscriber connection error:', err));

// Register Lua scripts
// 1. Invalidate and create session atomically
redis.defineCommand('invalidateAndCreateSession', {
  numberOfKeys: 2,
  lua: `
    local user_sessions_key = KEYS[1]
    local new_session_key = KEYS[2]
    local userId = ARGV[1]
    local sessionId = ARGV[2]
    local ipAddress = ARGV[3]
    local deviceType = ARGV[4]
    local createdAt = ARGV[5]
    local lastActive = ARGV[6]
    local ttl = tonumber(ARGV[7])

    -- 1. Get all old sessions for this user
    local old_sessions = redis.call('SMEMBERS', user_sessions_key)
    
    -- 2. Delete each old session hash
    for _, old_sess_id in ipairs(old_sessions) do
      redis.call('DEL', 'session:' .. old_sess_id)
    end

    -- 3. Clear the user sessions set
    redis.call('DEL', user_sessions_key)

    -- 4. Add the new session to the set
    redis.call('SADD', user_sessions_key, sessionId)

    -- 5. Create the new session hash
    redis.call('HSET', new_session_key,
      'userId', userId,
      'ipAddress', ipAddress,
      'deviceType', deviceType,
      'createdAt', createdAt,
      'lastActive', lastActive
    )

    -- 6. Set TTL on session key
    redis.call('EXPIRE', new_session_key, ttl)

    return "OK"
  `
});

// 2. Submit quiz round answer atomically
redis.defineCommand('submitRoundAnswer', {
  numberOfKeys: 4,
  lua: `
    local round_key = KEYS[1]
    local submissions_key = KEYS[2]
    local global_leaderboard_key = KEYS[3]
    local game_leaderboard_key = KEYS[4]

    local playerId = ARGV[1]
    local answer = ARGV[2]
    local currentTime = tonumber(ARGV[3])

    -- 1. Check if round exists
    local exists = redis.call('EXISTS', round_key)
    if exists == 0 then
      return {"error", "ROUND_NOT_FOUND"}
    end

    -- 2. Get round data
    local endTime = tonumber(redis.call('HGET', round_key, 'endTime'))
    local correctAnswer = redis.call('HGET', round_key, 'correctAnswer')
    local points = tonumber(redis.call('HGET', round_key, 'points')) or 0

    -- 3. Check if round is active
    if not endTime or currentTime >= endTime then
      return {"error", "ROUND_EXPIRED"}
    end

    -- 4. Check if player has already submitted
    local is_submitted = redis.call('SISMEMBER', submissions_key, playerId)
    if is_submitted == 1 then
      return {"error", "DUPLICATE_SUBMISSION"}
    end

    -- 5. Record submission
    redis.call('SADD', submissions_key, playerId)

    -- 6. Check answer and update score if correct
    local points_awarded = 0
    if correctAnswer and string.lower(answer) == string.lower(correctAnswer) then
      points_awarded = points
    end

    local new_score = 0
    if points_awarded > 0 then
      new_score = tonumber(redis.call('ZINCRBY', global_leaderboard_key, points_awarded, playerId))
      if game_leaderboard_key and game_leaderboard_key ~= "" then
        redis.call('ZINCRBY', game_leaderboard_key, points_awarded, playerId)
      end
    else
      local current_score = redis.call('ZSCORE', global_leaderboard_key, playerId)
      new_score = current_score and tonumber(current_score) or 0
    end

    return {"success", tostring(new_score), tostring(points_awarded)}
  `
});

module.exports = {
  redis,
  redisSub
};
