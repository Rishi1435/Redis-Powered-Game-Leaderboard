const Redis = require('ioredis');
const dotenv = require('dotenv');

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(redisUrl);

async function runBenchmark() {
  console.log('Starting Redis Memory Analysis & Benchmarking...');
  
  try {
    // 1. Analyze single session Hash
    const sessionKey = 'session:bench-test-123';
    await redis.del(sessionKey);
    await redis.hset(sessionKey, {
      userId: 'player-alpha-12345',
      ipAddress: '192.168.1.100',
      deviceType: 'desktop',
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString()
    });

    const hashMemory = await redis.call('MEMORY', 'USAGE', sessionKey);
    const hashEncoding = await redis.object('ENCODING', sessionKey);
    console.log('\n--- Session Hash (Single Key) ---');
    console.log(`Memory Usage: ${hashMemory} bytes`);
    console.log(`Object Encoding: ${hashEncoding}`);

    // Clean up session
    await redis.del(sessionKey);

    // Get current zset configuration name (check if listpack or ziplist is used)
    let zsetLimitConfigName = 'zset-max-listpack-entries';
    try {
      await redis.config('GET', 'zset-max-listpack-entries');
    } catch (e) {
      // Fallback for older Redis versions
      zsetLimitConfigName = 'zset-max-ziplist-entries';
    }
    console.log(`Detected ZSet threshold configuration parameter: ${zsetLimitConfigName}`);

    // Save original config value
    const originalConfigRaw = await redis.config('GET', zsetLimitConfigName);
    const originalValue = originalConfigRaw[1];
    console.log(`Original ${zsetLimitConfigName} value: ${originalValue}`);

    // Clean up any remaining bench keys
    await redis.del('leaderboard:bench:skiplist-100k');
    await redis.del('leaderboard:bench:skiplist-20k');
    await redis.del('leaderboard:bench:listpack-20k');

    // 2. Measure Sorted Set with 100k players under SKIPLIST encoding (default configuration)
    const numPlayers100k = 100000;
    const skiplist100kKey = 'leaderboard:bench:skiplist-100k';
    console.log(`\nSeeding ${numPlayers100k} players to ${skiplist100kKey} (Skiplist)...`);
    
    const batchSize = 10000;
    for (let i = 0; i < numPlayers100k; i += batchSize) {
      const pipeline = redis.pipeline();
      for (let j = 0; j < batchSize; j++) {
        const playerId = `player-${i + j}`;
        const score = Math.floor(Math.random() * 100000);
        pipeline.zadd(skiplist100kKey, score, playerId);
      }
      await pipeline.exec();
    }

    const skiplist100kMemory = await redis.call('MEMORY', 'USAGE', skiplist100kKey);
    const skiplist100kEncoding = await redis.object('ENCODING', skiplist100kKey);
    console.log('--- 100k Players Leaderboard (SKIPLIST) ---');
    console.log(`Memory Usage: ${skiplist100kMemory} bytes (~${(skiplist100kMemory / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`Object Encoding: ${skiplist100kEncoding}`);

    // 3. Comparative Analysis: 20k players under Skiplist vs Listpack
    const numPlayers20k = 20000;
    
    // 3a. Force Skiplist for 20k players
    console.log(`\nConfiguring ${zsetLimitConfigName} to 128 (forcing skiplist)...`);
    await redis.config('SET', zsetLimitConfigName, '128');
    const skiplist20kKey = 'leaderboard:bench:skiplist-20k';
    
    console.log(`Seeding ${numPlayers20k} players to ${skiplist20kKey} (Forced Skiplist)...`);
    for (let i = 0; i < numPlayers20k; i += batchSize) {
      const pipeline = redis.pipeline();
      for (let j = 0; j < batchSize; j++) {
        const playerId = `player-${i + j}`;
        const score = Math.floor(Math.random() * 100000);
        pipeline.zadd(skiplist20kKey, score, playerId);
      }
      await pipeline.exec();
    }
    const skiplist20kMemory = await redis.call('MEMORY', 'USAGE', skiplist20kKey);
    const skiplist20kEncoding = await redis.object('ENCODING', skiplist20kKey);
    console.log(`Memory Usage: ${skiplist20kMemory} bytes (~${(skiplist20kMemory / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`Object Encoding: ${skiplist20kEncoding}`);

    // 3b. Force Listpack for 20k players
    console.log(`\nConfiguring ${zsetLimitConfigName} to 25000 (forcing listpack)...`);
    await redis.config('SET', zsetLimitConfigName, '25000');
    const listpack20kKey = 'leaderboard:bench:listpack-20k';
    
    console.log(`Seeding ${numPlayers20k} players to ${listpack20kKey} (Forced Listpack)...`);
    for (let i = 0; i < numPlayers20k; i += batchSize) {
      const pipeline = redis.pipeline();
      for (let j = 0; j < batchSize; j++) {
        const playerId = `player-${i + j}`;
        const score = Math.floor(Math.random() * 100000);
        pipeline.zadd(listpack20kKey, score, playerId);
      }
      await pipeline.exec();
    }
    const listpack20kMemory = await redis.call('MEMORY', 'USAGE', listpack20kKey);
    const listpack20kEncoding = await redis.object('ENCODING', listpack20kKey);
    console.log(`Memory Usage: ${listpack20kMemory} bytes (~${(listpack20kMemory / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`Object Encoding: ${listpack20kEncoding}`);

    // 4. Restore original config and clean up keys
    console.log(`\nRestoring original ${zsetLimitConfigName} to ${originalValue}...`);
    await redis.config('SET', zsetLimitConfigName, originalValue);

    console.log('Cleaning up benchmark keys...');
    await redis.del(skiplist100kKey);
    await redis.del(skiplist20kKey);
    await redis.del(listpack20kKey);

    console.log('Benchmark finished successfully!');
    
    // Print comparative summary for easy copy-paste
    console.log('\n======================================');
    console.log('SUMMARY OF RESULTS');
    console.log('======================================');
    console.log(`Hash (Session) Memory:          ${hashMemory} bytes (${hashEncoding})`);
    console.log(`100k ZSet (Skiplist) Memory:     ${skiplist100kMemory} bytes (~${(skiplist100kMemory / 1024 / 1024).toFixed(2)} MB) (${skiplist100kEncoding})`);
    console.log(`20k ZSet (Skiplist) Memory:      ${skiplist20kMemory} bytes (~${(skiplist20kMemory / 1024 / 1024).toFixed(2)} MB) (${skiplist20kEncoding})`);
    console.log(`20k ZSet (Listpack) Memory:      ${listpack20kMemory} bytes (~${(listpack20kMemory / 1024 / 1024).toFixed(2)} MB) (${listpack20kEncoding})`);
    console.log(`Memory saved by Listpack (20k):  ${(((skiplist20kMemory - listpack20kMemory) / skiplist20kMemory) * 100).toFixed(2)}%`);
    console.log('======================================');

  } catch (err) {
    console.error('Error during benchmark:', err);
  } finally {
    redis.disconnect();
  }
}

runBenchmark();
