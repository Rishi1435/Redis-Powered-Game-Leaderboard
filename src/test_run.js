const http = require('http');

const API_BASE = 'http://localhost:3000';

// Helper to make HTTP requests using native http module (to avoid dependency issues)
function makeRequest(url, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        let parsed = data;
        try {
          if (data) {
            parsed = JSON.parse(data);
          }
        } catch (e) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Helper to wait
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTests() {
  console.log('==================================================');
  console.log('STARTING INTEGRATION VERIFICATION TESTS');
  console.log('==================================================\n');

  let passedTests = 0;
  let failedTests = 0;

  function assert(condition, message) {
    if (condition) {
      passedTests++;
      console.log(`✅ [PASS] ${message}`);
    } else {
      failedTests++;
      console.log(`❌ [FAIL] ${message}`);
    }
  }

  try {
    // 1. Health Check
    console.log('Testing /health endpoint...');
    const health = await makeRequest(`${API_BASE}/health`);
    assert(health.statusCode === 200, 'Health check status is 200 OK');
    assert(health.body.status === 'UP', 'Health check returns UP status');

    // 2. Session creation and Atomic Invalidation
    console.log('\nTesting session creation & atomic old-session invalidation...');
    const user = 'test-verification-user';
    
    // Create first session
    const s1 = await makeRequest(`${API_BASE}/api/sessions`, 'POST', {
      userId: user,
      ipAddress: '127.0.0.1',
      deviceType: 'desktop'
    });
    assert(s1.statusCode === 201, 'First session created successfully (201)');
    const sess1Id = s1.body.sessionId;
    assert(typeof sess1Id === 'string' && sess1Id.length > 0, `Session 1 ID: ${sess1Id}`);

    // Create second session (should atomically invalidate session 1)
    const s2 = await makeRequest(`${API_BASE}/api/sessions`, 'POST', {
      userId: user,
      ipAddress: '10.0.0.1',
      deviceType: 'mobile'
    });
    assert(s2.statusCode === 201, 'Second session created successfully (201)');
    const sess2Id = s2.body.sessionId;
    assert(typeof sess2Id === 'string' && sess2Id.length > 0, `Session 2 ID: ${sess2Id}`);

    // Look up sessions for user via admin endpoint
    const query = await makeRequest(`${API_BASE}/api/admin/sessions/user/${user}`);
    assert(query.statusCode === 200, 'Query user sessions status is 200 OK');
    assert(query.body.length === 1, `Query returned exactly 1 active session (found: ${query.body.length})`);
    assert(query.body[0].sessionId === sess2Id, 'Active session is the second session');

    // Verify session 1 was deleted
    const queryAllSess1 = query.body.some(s => s.sessionId === sess1Id);
    assert(!queryAllSess1, 'Stale session 1 was atomically invalidated/deleted');

    // 3. Leaderboard Score direct adjustment
    console.log('\nTesting Leaderboard score adjustments...');
    const player = 'player-verification-alpha';

    // Submit initial score 50
    const score1 = await makeRequest(`${API_BASE}/api/leaderboard/scores`, 'POST', {
      playerId: player,
      points: 50
    });
    assert(score1.statusCode === 200, 'Direct score submission status is 200 OK');
    assert(score1.body.newScore === 50, `Score is initialized to 50 (returned: ${score1.body.newScore})`);

    // Submit additional 25 points
    const score2 = await makeRequest(`${API_BASE}/api/leaderboard/scores`, 'POST', {
      playerId: player,
      points: 25
    });
    assert(score2.body.newScore === 75, `Score is atomically incremented to 75 (returned: ${score2.body.newScore})`);

    // 4. Leaderboard Top list & Player Context
    console.log('\nTesting Leaderboard top querying & context/percentiles...');
    // Seed 30 players
    console.log('Seeding leaderboard with 30 players...');
    for (let i = 1; i <= 30; i++) {
      await makeRequest(`${API_BASE}/api/leaderboard/scores`, 'POST', {
        playerId: `player-seed-${i}`,
        points: i * 10
      });
    }

    // Get top 10
    const top10 = await makeRequest(`${API_BASE}/api/leaderboard/top/10`);
    assert(top10.statusCode === 200, 'Get top 10 leaderboard status is 200 OK');
    assert(top10.body.length === 10, `Query returned exactly 10 players`);
    assert(top10.body[0].rank === 1, 'First player rank is 1');
    assert(top10.body[0].score >= top10.body[1].score, 'Scores are sorted in descending order');

    // Get context for rank 15 player (player-seed-15 has points 150)
    const context = await makeRequest(`${API_BASE}/api/leaderboard/player/player-seed-15`);
    assert(context.statusCode === 200, 'Player context lookup status is 200 OK');
    assert(context.body.playerId === 'player-seed-15', 'Returned correct player ID');
    assert(context.body.score === 150, `Returned correct player score (150)`);
    assert(typeof context.body.rank === 'number', `Returned player rank: ${context.body.rank}`);
    assert(typeof context.body.percentile === 'number', `Returned player percentile: ${context.body.percentile}%`);
    assert(context.body.nearbyPlayers.above.length > 0, 'Nearby players above is populated');
    assert(context.body.nearbyPlayers.below.length > 0, 'Nearby players below is populated');

    // 5. Quiz Round Submission (Atomic checks: round active, duplicates, expiration)
    console.log('\nTesting atomic game submissions (Lua script checks)...');
    const gameId = 'game-test-99';
    const roundId = 'round-v1';
    
    // Seed round with duration 4 seconds
    const seedRound = await makeRequest(`${API_BASE}/api/admin/rounds`, 'POST', {
      gameId,
      roundId,
      correctAnswer: 'Redis',
      points: 100,
      durationSeconds: 4
    });
    assert(seedRound.statusCode === 201, 'Game round seeded successfully (201)');

    // Submit correct answer
    const submit1 = await makeRequest(`${API_BASE}/api/game/submit`, 'POST', {
      gameId,
      roundId,
      playerId: 'player-round-tester',
      answer: 'Redis'
    });
    assert(submit1.statusCode === 200, 'Submission status is 200 OK');
    assert(submit1.body.status === 'SUCCESS', 'Submission returns SUCCESS');
    assert(submit1.body.pointsAwarded === 100, `Awarded correct points (+100)`);

    // Submit duplicate answer (same round, same player)
    const submitDuplicate = await makeRequest(`${API_BASE}/api/game/submit`, 'POST', {
      gameId,
      roundId,
      playerId: 'player-round-tester',
      answer: 'Redis'
    });
    assert(submitDuplicate.statusCode === 400, 'Duplicate submission returns 400 Bad Request');
    assert(submitDuplicate.body.code === 'DUPLICATE_SUBMISSION', 'Duplicate submission error code matches DUPLICATE_SUBMISSION');

    // Wait 5 seconds to expire the round
    console.log('Waiting 5 seconds for the round to expire...');
    await sleep(5000);

    // Submit answer to expired round
    const submitExpired = await makeRequest(`${API_BASE}/api/game/submit`, 'POST', {
      gameId,
      roundId,
      playerId: 'player-late-tester',
      answer: 'Redis'
    });
    assert(submitExpired.statusCode === 403, 'Late submission returns 403 Forbidden');
    assert(submitExpired.body.code === 'ROUND_EXPIRED', 'Late submission error code matches ROUND_EXPIRED');

    // 6. Admin deletion of session
    console.log('\nTesting Admin session invalidation...');
    const adminSessUser = 'admin-test-user';
    const createAdminSess = await makeRequest(`${API_BASE}/api/sessions`, 'POST', {
      userId: adminSessUser,
      ipAddress: '127.0.0.1',
      deviceType: 'tablet'
    });
    const adminSessId = createAdminSess.body.sessionId;

    // Delete session
    const deleteSess = await makeRequest(`${API_BASE}/api/admin/sessions/${adminSessId}`, 'DELETE');
    assert(deleteSess.statusCode === 204, 'Admin delete session status is 204 No Content');

    // Lookup sessions - should be empty
    const lookupAdminSess = await makeRequest(`${API_BASE}/api/admin/sessions/user/${adminSessUser}`);
    assert(lookupAdminSess.body.length === 0, 'Admin deleted session successfully cleaned up in index Set');

  } catch (err) {
    console.error('Unexpected error during verification:', err);
    failedTests++;
  }

  console.log('\n==================================================');
  console.log('VERIFICATION TESTS COMPLETED');
  console.log(`Passed: ${passedTests} | Failed: ${failedTests}`);
  console.log('==================================================');
}

runTests();
