// TriviaBlast Live Dashboard Controller

let activeSession = null;
let sseSource = null;
let sessionTtlInterval = null;
let roundTimerInterval = null;

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSSE();
  fetchLeaderboard();

  // Load active session from sessionStorage if exists
  const cachedSession = sessionStorage.getItem('trivia_session');
  if (cachedSession) {
    try {
      activeSession = JSON.parse(cachedSession);
      showActiveSession(activeSession);
    } catch (e) {
      sessionStorage.removeItem('trivia_session');
    }
  }

  // Set up refresh button
  document.getElementById('refresh-leaderboard-btn').addEventListener('click', fetchLeaderboard);

  // Form event listeners
  document.getElementById('session-form').addEventListener('submit', handleCreateSession);
  document.getElementById('score-form').addEventListener('submit', handleDirectScoreSubmit);
  document.getElementById('seed-round-form').addEventListener('submit', handleSeedRound);
  document.getElementById('submit-answer-form').addEventListener('submit', handleSubmitAnswer);
  document.getElementById('lookup-sessions-form').addEventListener('submit', handleLookupSessions);
  document.getElementById('btn-logout-session').addEventListener('click', handleInvalidateActiveSession);
});

// --- Tab Navigation ---
function initTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  const panes = document.querySelectorAll('.tab-pane');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panes.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const paneId = tab.dataset.tab;
      document.getElementById(paneId).classList.add('active');
    });
  });
}

// --- SSE Event Stream ---
function initSSE() {
  const badge = document.getElementById('sse-connection-badge');
  const feed = document.getElementById('event-feed');

  if (sseSource) {
    sseSource.close();
  }

  sseSource = new EventSource('/api/events');

  sseSource.onopen = () => {
    badge.textContent = 'Live Feed Active';
    badge.className = 'ticker-badge connected';
    addTickerItem('System', 'Connected to real-time events stream.', 'ticker-alert');
  };

  sseSource.onerror = () => {
    badge.textContent = 'Disconnected';
    badge.className = 'ticker-badge';
    addTickerItem('System', 'Connection lost. Retrying...', 'ticker-alert');
  };

  sseSource.addEventListener('leaderboard_updated', (event) => {
    try {
      const data = JSON.parse(event.data);
      addTickerItem(
        'Leaderboard', 
        `Player <strong>${data.playerId}</strong> score updated to <strong>${data.newScore}</strong>.`, 
        'ticker-update'
      );
      fetchLeaderboard();
    } catch (e) {
      console.error('Error parsing SSE event:', e);
    }
  });
}

function addTickerItem(source, message, typeClass = '') {
  const feed = document.getElementById('event-feed');
  const placeholder = feed.querySelector('.ticker-placeholder');
  if (placeholder) {
    placeholder.remove();
  }

  const time = new Date().toLocaleTimeString();
  const item = document.createElement('div');
  item.className = `ticker-item ${typeClass}`;
  item.innerHTML = `
    <span class="ticker-time">[${time}]</span>
    <span class="ticker-source"><strong>${source}:</strong></span>
    <span class="ticker-text">${message}</span>
  `;

  feed.prepend(item);

  // Cap ticker items to 15
  while (feed.children.length > 15) {
    feed.lastChild.remove();
  }
}

// --- API Helpers ---
async function apiRequest(url, method = 'GET', body = null, useSession = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (useSession && activeSession) {
    headers['x-session-id'] = activeSession.sessionId;
  }

  const options = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  if (res.status === 204) return null;
  
  const data = await res.json();
  if (!res.ok) {
    throw { status: res.status, ...data };
  }
  return data;
}

// --- Leaderboard Operations ---
async function fetchLeaderboard() {
  const tbody = document.getElementById('leaderboard-body');
  try {
    const data = await apiRequest('/api/leaderboard/top/10', 'GET', null, false);
    tbody.innerHTML = '';
    
    if (data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="text-center loading-text">No players on the leaderboard yet.</td></tr>`;
      return;
    }

    data.forEach(player => {
      const row = document.createElement('tr');
      
      // Rank Badge
      let rankContent = '';
      if (player.rank === 1) rankContent = '<span class="rank-badge rank-1">1</span>';
      else if (player.rank === 2) rankContent = '<span class="rank-badge rank-2">2</span>';
      else if (player.rank === 3) rankContent = '<span class="rank-badge rank-3">3</span>';
      else rankContent = `<span class="rank-badge rank-other">${player.rank}</span>`;

      // Active player highlight
      const isMe = activeSession && player.playerId === activeSession.userId;
      const playerClass = isMe ? 'player-cell highlight' : 'player-cell';
      const playerName = isMe ? `${player.playerId} (You)` : player.playerId;

      row.innerHTML = `
        <td class="col-rank">${rankContent}</td>
        <td class="col-player ${playerClass}">${playerName}</td>
        <td class="col-score score-cell">${player.score}</td>
      `;
      tbody.appendChild(row);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="text-center text-danger">Failed to load leaderboard.</td></tr>`;
    console.error('Error fetching leaderboard:', err);
  }
}

// --- Session Handling ---
async function handleCreateSession(e) {
  e.preventDefault();
  const userId = document.getElementById('sess-user-id').value.trim();
  const deviceType = document.getElementById('sess-device').value;
  const ipAddress = document.getElementById('sess-ip').value.trim();

  try {
    const data = await apiRequest('/api/sessions', 'POST', { userId, deviceType, ipAddress }, false);
    activeSession = {
      sessionId: data.sessionId,
      userId,
      deviceType,
      ipAddress
    };

    sessionStorage.setItem('trivia_session', JSON.stringify(activeSession));
    showActiveSession(activeSession);
    addTickerItem('Session', `New session created for user <strong>${userId}</strong>. Old sessions invalidated.`, 'ticker-update');
    fetchLeaderboard();
  } catch (err) {
    alert('Failed to create session: ' + (err.error || 'Server error'));
  }
}

function showActiveSession(session) {
  document.getElementById('active-session-display').style.display = 'block';
  document.getElementById('display-session-id').textContent = session.sessionId;
  document.getElementById('display-user-id').textContent = session.userId;
  document.getElementById('display-device').textContent = session.deviceType;
  document.getElementById('display-ip').textContent = session.ipAddress;
  
  // Prefill inputs
  document.getElementById('score-player-id').value = session.userId;
  document.getElementById('submit-player-id').value = session.userId;

  // Poll Session TTL to show sliding expiration
  if (sessionTtlInterval) clearInterval(sessionTtlInterval);
  pollSessionTtl();
  sessionTtlInterval = setInterval(pollSessionTtl, 5000);
}

async function pollSessionTtl() {
  if (!activeSession) return;
  try {
    // Query active sessions for the user to retrieve the exact TTL
    const sessions = await apiRequest(`/api/admin/sessions/user/${activeSession.userId}`, 'GET', null, true);
    const match = sessions.find(s => s.sessionId === activeSession.sessionId);
    if (match) {
      const mins = Math.floor(match.ttl / 60);
      const secs = match.ttl % 60;
      document.getElementById('display-ttl').textContent = `${mins}m ${secs}s`;
    } else {
      // Session has been invalidated or expired
      handleLocalSessionExpire();
    }
  } catch (err) {
    console.error('Error polling session TTL:', err);
  }
}

async function handleInvalidateActiveSession() {
  if (!activeSession) return;
  try {
    await apiRequest(`/api/admin/sessions/${activeSession.sessionId}`, 'DELETE', null, true);
    addTickerItem('Session', `Active session <strong>${activeSession.sessionId}</strong> manually invalidated.`, 'ticker-alert');
    handleLocalSessionExpire();
  } catch (err) {
    alert('Failed to invalidate session: ' + (err.error || 'Server error'));
  }
}

function handleLocalSessionExpire() {
  activeSession = null;
  sessionStorage.removeItem('trivia_session');
  document.getElementById('active-session-display').style.display = 'none';
  document.getElementById('display-session-id').textContent = '-';
  document.getElementById('display-user-id').textContent = '-';
  document.getElementById('display-ttl').textContent = '-';
  
  if (sessionTtlInterval) {
    clearInterval(sessionTtlInterval);
    sessionTtlInterval = null;
  }
  
  addTickerItem('Session', 'Active session cleared.', 'ticker-alert');
  fetchLeaderboard();
}

// --- Leaderboard adjustments ---
async function handleDirectScoreSubmit(e) {
  e.preventDefault();
  const playerId = document.getElementById('score-player-id').value.trim();
  const points = parseInt(document.getElementById('score-points').value, 10);

  try {
    const data = await apiRequest('/api/leaderboard/scores', 'POST', { playerId, points });
    document.getElementById('score-points').value = '';
    // Event will be received via SSE to update UI
  } catch (err) {
    alert('Failed to update score: ' + (err.error || 'Server error'));
  }
}

// --- Quiz Rounds ---
async function handleSeedRound(e) {
  e.preventDefault();
  const gameId = document.getElementById('game-id').value.trim();
  const roundId = document.getElementById('round-id').value.trim();
  const correctAnswer = document.getElementById('correct-answer').value.trim();
  const points = parseInt(document.getElementById('round-points').value, 10);
  const durationSeconds = parseInt(document.getElementById('duration').value, 10);

  try {
    const data = await apiRequest('/api/admin/rounds', 'POST', {
      gameId, roundId, durationSeconds, correctAnswer, points
    });

    startRoundCountdown(gameId, roundId, data.endTime, correctAnswer);
    addTickerItem('Game Admin', `Round <strong>${roundId}</strong> for game <strong>${gameId}</strong> seeded.`, 'ticker-alert');
  } catch (err) {
    alert('Failed to seed round: ' + (err.error || 'Server error'));
  }
}

function startRoundCountdown(gameId, roundId, endTime, correctAnswer) {
  const banner = document.getElementById('active-round-banner');
  const title = document.getElementById('banner-round-title');
  const answerDisp = document.getElementById('banner-correct-answer');
  const timer = document.getElementById('banner-timer');

  banner.style.display = 'flex';
  title.textContent = `${gameId} : ${roundId}`;
  answerDisp.textContent = correctAnswer;

  if (roundTimerInterval) clearInterval(roundTimerInterval);

  function updateTimer() {
    const remaining = Math.max(0, Math.round((endTime - Date.now()) / 1000));
    timer.textContent = `${remaining}s`;

    if (remaining <= 0) {
      clearInterval(roundTimerInterval);
      timer.textContent = 'EXPIRED';
      timer.className = 'time-countdown text-danger';
      addTickerItem('Game', `Round <strong>${roundId}</strong> has expired.`, 'ticker-alert');
    } else {
      timer.className = 'time-countdown';
    }
  }

  updateTimer();
  roundTimerInterval = setInterval(updateTimer, 1000);
}

async function handleSubmitAnswer(e) {
  e.preventDefault();
  const gameId = document.getElementById('game-id').value.trim();
  const roundId = document.getElementById('round-id').value.trim();
  const playerId = document.getElementById('submit-player-id').value.trim();
  const answer = document.getElementById('submit-answer').value.trim();

  const feedback = document.getElementById('game-feedback');
  feedback.style.display = 'none';

  try {
    const data = await apiRequest('/api/game/submit', 'POST', {
      gameId, roundId, playerId, answer
    });

    feedback.style.display = 'block';
    feedback.className = 'alert-box success';
    
    if (data.pointsAwarded > 0) {
      feedback.innerHTML = `<strong>Correct Answer!</strong> Awarded +${data.pointsAwarded} points. New Score: ${data.newScore}`;
      addTickerItem('Game', `Player <strong>${playerId}</strong> submitted correct answer: "${answer}" (+${data.pointsAwarded} pts)`, 'ticker-update');
    } else {
      feedback.innerHTML = `<strong>Wrong Answer!</strong> Submitted: "${answer}" (0 points). Score remains: ${data.newScore}`;
      addTickerItem('Game', `Player <strong>${playerId}</strong> submitted incorrect answer: "${answer}" (0 pts)`, 'ticker-update');
    }
    
    document.getElementById('submit-answer').value = '';
    fetchLeaderboard();
  } catch (err) {
    feedback.style.display = 'block';
    feedback.className = 'alert-box danger';
    
    if (err.code === 'ROUND_EXPIRED') {
      feedback.innerHTML = `<strong>Submission Rejected:</strong> Round window is closed (ROUND_EXPIRED).`;
    } else if (err.code === 'DUPLICATE_SUBMISSION') {
      feedback.innerHTML = `<strong>Submission Rejected:</strong> Duplicate answer. You have already submitted for this round (DUPLICATE_SUBMISSION).`;
    } else {
      feedback.innerHTML = `<strong>Submission Failed:</strong> ${err.error || 'Server error.'}`;
    }
  }
}

// --- Admin Session Query ---
async function handleLookupSessions(e) {
  e.preventDefault();
  const userId = document.getElementById('lookup-user-id').value.trim();
  const container = document.getElementById('lookup-results-container');
  const tbody = document.getElementById('lookup-sessions-body');

  try {
    const data = await apiRequest(`/api/admin/sessions/user/${userId}`, 'GET');
    tbody.innerHTML = '';
    container.style.display = 'block';

    if (data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center loading-text">No active sessions found for this user.</td></tr>`;
      return;
    }

    data.forEach(sess => {
      const row = document.createElement('tr');
      const mins = Math.floor(sess.ttl / 60);
      const secs = sess.ttl % 60;

      row.innerHTML = `
        <td><span class="code">${sess.sessionId.substring(0, 8)}...</span></td>
        <td>${sess.deviceType}</td>
        <td>${sess.ipAddress}</td>
        <td>${mins}m ${secs}s</td>
        <td>
          <button class="btn btn-danger btn-sm" onclick="invalidateSessionFromAdmin('${sess.sessionId}', '${userId}')">
            Invalidate
          </button>
        </td>
      `;
      tbody.appendChild(row);
    });
  } catch (err) {
    alert('Failed to lookup sessions: ' + (err.error || 'Server error'));
  }
}

// Global hook for inline delete buttons
window.invalidateSessionFromAdmin = async function(sessionId, userId) {
  try {
    await apiRequest(`/api/admin/sessions/${sessionId}`, 'DELETE');
    addTickerItem('Admin', `Invalidated session <strong>${sessionId}</strong> for user <strong>${userId}</strong>.`, 'ticker-alert');
    
    // Check if it's our own active session
    if (activeSession && activeSession.sessionId === sessionId) {
      handleLocalSessionExpire();
    }
    
    // Re-trigger query
    document.getElementById('lookup-user-id').value = userId;
    document.getElementById('lookup-sessions-form').dispatchEvent(new Event('submit'));
  } catch (err) {
    alert('Failed to delete session: ' + (err.error || 'Server error'));
  }
};
