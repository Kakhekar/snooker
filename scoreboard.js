(function(){
  const BALL_VALUES = {red:1, yellow:2, green:3, brown:4, blue:5, pink:6, black:7};
  const COLOUR_ORDER = ['yellow','green','brown','blue','pink','black'];
  const ACCENTS = ['#e8b923','#3a8bd6','#c96b8a','#5fb56e','#e0793f','#9b7fe0','#5cc9c9','#d6667a'];

  // ================= FIREBASE SETUP =================
  // Replace this with YOUR project's config from the Firebase console:
  // Project settings → General → Your apps → (web app) → SDK setup and configuration
  const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

  let firebaseReady = false;
  let db = null;
  try{
    if(firebaseConfig.apiKey && firebaseConfig.apiKey !== 'YOUR_API_KEY' && typeof firebase !== 'undefined'){
      firebase.initializeApp(firebaseConfig);
      db = firebase.firestore();
      firebaseReady = true;
      // Sanity check: confirm we can actually reach this Firestore project.
      // If the config points at a project that doesn't exist, isn't yours,
      // or has Firestore rules/network blocking reads, this will fail and
      // we fall back to local-only mode with a visible on-screen notice.
      db.collection('snookerRooms').limit(1).get().catch(err=>{
        console.error('Firestore reachability check failed — falling back to local-only mode:', err);
        firebaseReady = false;
        const notice = document.getElementById('noSyncNotice');
        if(notice) notice.style.display = 'block';
      });
    }
  } catch(e){
    console.error('Firebase init failed:', e);
    firebaseReady = false;
  }

  // dbRoomId: the actual Firestore document id (always the "edit" code) that the
  // realtime listener is attached to — used for both editors and viewers.
  // displayCode: the code shown/copyable in the badge — the edit code for the
  // owner/editor, or the viewer's own view-only code for a viewer (so a viewer
  // never sees or leaks the underlying edit code).
  let dbRoomId = null;
  let displayCode = null;
  let currentViewCode = null; // owner's paired view-only code, shown for sharing
  let isViewer = false;
  let syncEnabled = false;
  let unsubscribeFn = null;
  let localVersion = 0;
  let applyingRemote = false;

  function generateRoomCode(){
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
    let code = '';
    for(let i=0;i<5;i++) code += chars[Math.floor(Math.random()*chars.length)];
    return code;
  }

  function updateSyncBadge(status){
    const badge = document.getElementById('syncBadge');
    if(!badge) return;
    if(!displayCode){ badge.style.display = 'none'; return; }
    badge.style.display = 'flex';
    const dot = badge.querySelector('.sync-dot');
    const label = badge.querySelector('.sync-label');
    const viewFlag = document.getElementById('viewerFlag');
    const ownerRow = document.getElementById('ownerCodeRow');
    const viewerRow = document.getElementById('viewerCodeRow');
    const viewerRowLabel = document.getElementById('viewerRowLabel');
    const copyViewBtn = document.getElementById('copyViewCodeBtn');

    viewFlag.style.display = isViewer ? 'inline-block' : 'none';

    if(isViewer){
      ownerRow.style.display = 'none';
      viewerRow.style.display = 'flex';
      viewerRowLabel.textContent = 'Watching code';
      viewerRow.querySelector('.sync-view-code').textContent = displayCode;
      copyViewBtn.style.display = 'none';
    } else {
      ownerRow.style.display = 'flex';
      ownerRow.querySelector('.sync-code').textContent = displayCode;
      if(currentViewCode){
        viewerRow.style.display = 'flex';
        viewerRowLabel.textContent = 'Viewer code';
        viewerRow.querySelector('.sync-view-code').textContent = currentViewCode;
        copyViewBtn.style.display = 'inline';
      } else {
        viewerRow.style.display = 'none';
      }
    }

    if(status === 'live'){ dot.style.background = '#5fb56e'; label.textContent = 'Live'; }
    else if(status === 'connecting'){ dot.style.background = '#e8b923'; label.textContent = 'Connecting…'; }
    else { dot.style.background = '#c0392b'; label.textContent = 'Offline — retrying'; }
  }

  function ensureStateShape(){
    // Backfill fields for rooms/state created before comments & reactions existed.
    if(!state) return;
    if(!Array.isArray(state.comments)) state.comments = [];
    if(!('reaction' in state)) state.reaction = null;
  }

  function startSync(dbId){
    if(!firebaseReady) return;
    dbRoomId = dbId;
    syncEnabled = true;
    updateSyncBadge('connecting');
    if(unsubscribeFn) unsubscribeFn();
    unsubscribeFn = db.collection('snookerRooms').doc(dbId).onSnapshot(snap=>{
      if(!snap.exists) return;
      updateSyncBadge('live');
      if(snap.metadata.hasPendingWrites) return; // this is the local echo of our own write
      const data = snap.data();
      if(!data) return;
      localVersion = data.version || localVersion;
      applyingRemote = true;
      try{
        state = JSON.parse(data.json);
        ensureStateShape();
        if(!isViewer && data.viewCode) currentViewCode = data.viewCode;
      } catch(e){ console.error('Bad remote state', e); }
      render();
      applyingRemote = false;
    }, err=>{
      console.error('Sync error', err);
      updateSyncBadge('offline');
    });
  }

  function stopSync(){
    if(unsubscribeFn) unsubscribeFn();
    unsubscribeFn = null;
    syncEnabled = false;
    dbRoomId = null;
    displayCode = null;
    currentViewCode = null;
    isViewer = false;
    updateSyncBadge('offline');
  }

  function createViewLink(viewCode, targetRoomId){
    if(!firebaseReady) return;
    db.collection('snookerViewLinks').doc(viewCode).set({
      roomId: targetRoomId,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(err=> console.error('View link creation failed', err));
  }

  function saveState(){
    if(!syncEnabled || !firebaseReady || !dbRoomId || !db || isViewer) return;
    localVersion += 1;
    db.collection('snookerRooms').doc(dbRoomId).set({
      json: JSON.stringify(state),
      version: localVersion,
      viewCode: currentViewCode || null,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(err=>{
      console.error('Save failed', err);
      updateSyncBadge('offline');
    });
  }

  // Comments and emoji reactions are allowed from viewers too (like Insta Live
  // chat), so this writes only the fields that change and merges rather than
  // overwriting the whole document — it never touches viewCode, so a viewer's
  // write can't clobber the room's sharing codes.
  function pushCommentOrReaction(){
    if(!syncEnabled || !firebaseReady || !dbRoomId || !db) return;
    localVersion += 1;
    db.collection('snookerRooms').doc(dbRoomId).set({
      json: JSON.stringify(state),
      version: localVersion,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, {merge:true}).catch(err=>{
      console.error('Comment/reaction sync failed', err);
    });
  }
  // ================= END FIREBASE SETUP =================

  let state = null;
  let history = [];
  let mode = 'individual';

  // ---- commenter identity (kept locally on this device/browser) ----
  let myName = '';
  try{ myName = localStorage.getItem('snookerCommenterName') || ''; } catch(e){ /* storage unavailable */ }
  const myAccent = ACCENTS[Math.floor(Math.random()*ACCENTS.length)];
  let lastAnimatedReactionId = null;

  // ---- comments are ephemeral, like Insta Live: pop up, sit a few seconds,
  // fade out, and then get pruned out of the synced state entirely. ----
  const COMMENT_DISPLAY_MS = 4500;               // how long a bubble stays on screen
  const COMMENT_PRUNE_AFTER_MS = 9000;            // grace period before it's deleted from the shared/synced state, so slower-joining devices still get to see it
  const shownCommentIds = new Set();              // comment ids already popped up on this device
  let commentPruneTimer = null;
  function startCommentPruning(){
    stopCommentPruning();
    commentPruneTimer = setInterval(pruneExpiredComments, 2000);
  }
  function stopCommentPruning(){
    if(commentPruneTimer){ clearInterval(commentPruneTimer); commentPruneTimer = null; }
  }
  function pruneExpiredComments(){
    if(!state || !Array.isArray(state.comments) || !state.comments.length) return;
    const now = Date.now();
    const before = state.comments.length;
    state.comments = state.comments.filter(c => (now - (c.ts||0)) < COMMENT_PRUNE_AFTER_MS);
    if(state.comments.length !== before && !applyingRemote){
      pushCommentOrReaction();
    }
  }

  const setupScreen = document.getElementById('setupScreen');
  const matchScreen = document.getElementById('matchScreen');
  const playerRows = document.getElementById('playerRows');
  const teamRows = document.getElementById('teamRows');
  const setupError = document.getElementById('setupError');

  // ---------- SETUP: mode toggle ----------
  document.querySelectorAll('.mode-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      mode = btn.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach(b=>b.classList.toggle('active', b===btn));
      document.getElementById('individualSetup').style.display = mode==='individual' ? 'block':'none';
      document.getElementById('teamSetup').style.display = mode==='team' ? 'block':'none';
      setupError.textContent = '';
    });
  });

  // ---------- SETUP: player rows ----------
  function addPlayerRow(prefillName){
    const idx = playerRows.children.length + 1;
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `<input type="text" class="player-name-input" placeholder="Player ${idx}" maxlength="18" value="${prefillName||''}">
      <button class="remove-row-btn" title="Remove">✕</button>`;
    row.querySelector('.remove-row-btn').addEventListener('click', ()=>{
      if(playerRows.children.length <= 2) return;
      row.remove();
      updateRemoveState();
    });
    playerRows.appendChild(row);
    updateRemoveState();
  }
  function updateRemoveState(){
    const rows = playerRows.querySelectorAll('.remove-row-btn');
    rows.forEach(b => b.disabled = playerRows.children.length <= 2);
    const trows = teamRows.querySelectorAll('.remove-row-btn');
    trows.forEach(b => b.disabled = teamRows.children.length <= 2);
  }
  document.getElementById('addPlayerBtn').addEventListener('click', ()=> addPlayerRow());

  // ---------- SETUP: team rows ----------
  function addTeamRow(prefillName, p1, p2){
    const idx = teamRows.children.length + 1;
    const row = document.createElement('div');
    row.className = 'team-row';
    row.innerHTML = `<button class="remove-row-btn" title="Remove">✕</button>
      <input type="text" class="team-name-input" placeholder="Team ${idx} name (optional)" maxlength="20" value="${prefillName||''}">
      <div class="team-members">
        <input type="text" class="team-p1-input" placeholder="Player A" maxlength="16" value="${p1||''}">
        <input type="text" class="team-p2-input" placeholder="Player B" maxlength="16" value="${p2||''}">
      </div>`;
    row.querySelector('.remove-row-btn').addEventListener('click', ()=>{
      if(teamRows.children.length <= 2) return;
      row.remove();
      updateRemoveState();
    });
    teamRows.appendChild(row);
    updateRemoveState();
  }
  document.getElementById('addTeamBtn').addEventListener('click', ()=> addTeamRow());

  // seed defaults
  addPlayerRow(); addPlayerRow();
  addTeamRow(); addTeamRow();

  // ---------- START / JOIN MATCH ----------
  function freshState(competitorDefs, preserveLog, preserveComments){
    return {
      competitors: competitorDefs.map((c,i)=>({
        id:i, name:c.name, members:c.members||null,
        score:0, frames:0, bestBreak:0, curBreak:0
      })),
      turn:0,
      redsLeft:15,
      colourStage:0,
      log: preserveLog ? preserveLog.slice() : [],
      comments: preserveComments ? preserveComments.slice() : [],
      reaction: null
    };
  }
  function pushLog(text, val, accent){
    state.log.push({text, val: val || '', accent: accent || null});
    if(state.log.length > 300) state.log.shift();
  }

  function applyViewerModeUI(){
    matchScreen.classList.toggle('viewer-mode', isViewer);
    document.getElementById('newMatchBtn').textContent = isViewer ? 'Stop viewing' : 'New match (change players)';
    document.getElementById('controlsHint').textContent = isViewer
      ? "You're watching this match live, read-only. Ask whoever's scoring for the edit code if you'd like to take control. You can still comment and react below."
      : "Colours are unlimited while reds remain. Once all reds are gone, pot colours in order: yellow → green → brown → blue → pink → black. Tap any scorecard to switch the turn straight to that player.";
  }

  function initCommentsUI(){
    const nameInput = document.getElementById('commentNameInput');
    if(nameInput) nameInput.value = myName;
    lastAnimatedReactionId = (state && state.reaction) ? state.reaction.id : null;
    shownCommentIds.clear();
    const popupLayer = document.getElementById('commentsPopupLayer');
    if(popupLayer) popupLayer.innerHTML = '';
    // don't pop up comments that were already sitting there before we joined —
    // just mark them as seen so only genuinely new ones animate in.
    if(state && Array.isArray(state.comments)){
      state.comments.forEach(c => shownCommentIds.add(c.id));
    }
    startCommentPruning();
  }

  document.getElementById('startBtn').addEventListener('click', async ()=>{
    setupError.textContent = '';
    const roomInput = document.getElementById('roomCodeInput').value.trim().toUpperCase();

    // ----- JOIN an existing room, either to edit or to view -----
    if(roomInput){
      if(!firebaseReady){
        setupError.textContent = "Sync isn't set up yet — add your Firebase config in the file first.";
        return;
      }
      setupError.textContent = 'Connecting…';
      try{
        let targetDbId = null;
        let viewerMode = false;
        let snap = await db.collection('snookerRooms').doc(roomInput).get();

        if(snap.exists){
          targetDbId = roomInput;
        } else {
          const linkSnap = await db.collection('snookerViewLinks').doc(roomInput).get();
          if(linkSnap.exists){
            targetDbId = linkSnap.data().roomId;
            viewerMode = true;
            snap = await db.collection('snookerRooms').doc(targetDbId).get();
          }
        }

        if(!targetDbId || !snap.exists){
          setupError.textContent = 'No room found with code ' + roomInput + '.';
          return;
        }

        const data = snap.data();
        state = JSON.parse(data.json);
        ensureStateShape();
        localVersion = data.version || 0;
        history = [];
        isViewer = viewerMode;
        displayCode = roomInput;
        currentViewCode = viewerMode ? null : (data.viewCode || null);

        applyingRemote = true;
        setupScreen.style.display = 'none';
        matchScreen.style.display = 'block';
        document.getElementById('winnerBanner').style.display = 'none';
        document.getElementById('noSyncNotice').style.display = 'none';
        applyViewerModeUI();
        initCommentsUI();
        render();
        applyingRemote = false;
        startSync(targetDbId);
        setupError.textContent = '';
      } catch(err){
        console.error(err);
        setupError.textContent = 'Could not connect — check your Firebase config and connection.';
      }
      return;
    }

    // ----- CREATE a new match (optionally a new live room) -----
    let defs = [];
    if(mode === 'individual'){
      const inputs = [...playerRows.querySelectorAll('.player-name-input')];
      defs = inputs.map((inp,i)=>({name: inp.value.trim() || ('Player ' + (i+1))}));
      if(defs.length < 2){ setupError.textContent = 'Add at least 2 players.'; return; }
    } else {
      const rows = [...teamRows.children];
      defs = rows.map((row,i)=>{
        const tn = row.querySelector('.team-name-input').value.trim();
        const p1 = row.querySelector('.team-p1-input').value.trim() || ('Player ' + (i*2+1));
        const p2 = row.querySelector('.team-p2-input').value.trim() || ('Player ' + (i*2+2));
        return { name: tn || (p1 + ' & ' + p2), members:[p1,p2] };
      });
      if(defs.length < 2){ setupError.textContent = 'Add at least 2 teams.'; return; }
    }
    state = freshState(defs);
    history = [];
    isViewer = false;
    setupScreen.style.display = 'none';
    matchScreen.style.display = 'block';
    document.getElementById('winnerBanner').style.display = 'none';

    const noSyncNotice = document.getElementById('noSyncNotice');
    if(firebaseReady){
      noSyncNotice.style.display = 'none';
      const editCode = generateRoomCode();
      const viewCode = generateRoomCode();
      currentViewCode = viewCode;
      displayCode = editCode;
      createViewLink(viewCode, editCode);
      startSync(editCode);
    } else {
      dbRoomId = null;
      displayCode = null;
      currentViewCode = null;
      syncEnabled = false;
      noSyncNotice.style.display = 'block';
    }
    applyViewerModeUI();
    initCommentsUI();
    render();
  });

  // ---------- MATCH LOGIC ----------
  function snapshot(){
    history.push(JSON.parse(JSON.stringify(state)));
    if(history.length > 80) history.shift();
  }
  function undo(){
    if(isViewer) return;
    if(history.length === 0) return;
    state = JSON.parse(JSON.stringify(history.pop()));
    closeFoulPanel();
    render();
  }
  function nextIndex(i){ return (i + 1) % state.competitors.length; }

  function potBall(ball){
    if(isViewer) return;
    snapshot();
    const val = BALL_VALUES[ball];
    if(state.redsLeft > 0){
      if(ball === 'red') state.redsLeft -= 1;
    } else {
      const expected = COLOUR_ORDER[state.colourStage];
      if(ball === expected) state.colourStage = Math.min(state.colourStage + 1, COLOUR_ORDER.length - 1);
    }
    const c = state.competitors[state.turn];
    c.score += val;
    c.curBreak += val;
    if(c.curBreak > c.bestBreak) c.bestBreak = c.curBreak;
    const ballLabel = ball.charAt(0).toUpperCase() + ball.slice(1);
    pushLog(c.name + ' pots ' + ballLabel, '+' + val, ACCENTS[state.turn % ACCENTS.length]);
    render();
  }

  function selectTurn(i){
    if(isViewer) return;
    if(i === state.turn) return;
    snapshot();
    state.competitors[state.turn].curBreak = 0;
    const targetName = state.competitors[i].name;
    state.turn = i;
    pushLog('Turn passed to ' + targetName, '', ACCENTS[i % ACCENTS.length]);
    render();
  }

  function switchTurn(){
    if(isViewer) return;
    selectTurn(nextIndex(state.turn));
  }

  function awardFoul(val){
    if(isViewer) return;
    snapshot();
    const offender = state.competitors[state.turn];
    const offenderName = offender.name;
    offender.score -= val;
    offender.curBreak = 0;
    state.turn = nextIndex(state.turn);
    pushLog('Foul by ' + offenderName, '-' + val, '#c0392b');
    closeFoulPanel();
    render();
  }

  function endFrame(){
    if(isViewer) return;
    snapshot();
    const maxScore = Math.max(...state.competitors.map(c=>c.score));
    const winners = state.competitors.filter(c=>c.score === maxScore);
    winners.forEach(w=> w.frames += 1);
    const banner = document.getElementById('winnerBanner');
    banner.style.display = 'block';
    const bannerText = winners.length > 1
      ? 'Frame tied: ' + winners.map(w=>w.name).join(' & ')
      : winners[0].name + ' wins the frame!';
    banner.textContent = bannerText;
    pushLog(bannerText, '', null);
    render();
  }

  function newFrame(){
    if(isViewer) return;
    snapshot();
    const defs = state.competitors.map(c=>({name:c.name, members:c.members}));
    const frameCounts = state.competitors.map(c=>c.frames);
    const preservedLog = state.log;
    const preservedComments = state.comments;
    state = freshState(defs, preservedLog, preservedComments);
    state.competitors.forEach((c,i)=> c.frames = frameCounts[i]);
    pushLog('New frame started', '', null);
    document.getElementById('winnerBanner').style.display = 'none';
    render();
  }

  function newMatch(){
    matchScreen.style.display = 'none';
    matchScreen.classList.remove('viewer-mode');
    setupScreen.style.display = 'block';
    document.getElementById('winnerBanner').style.display = 'none';
    closeFoulPanel();
    stopSync();
    stopCommentPruning();
    shownCommentIds.clear();
    const popupLayer = document.getElementById('commentsPopupLayer');
    if(popupLayer) popupLayer.innerHTML = '';
  }

  function closeFoulPanel(){
    document.getElementById('foulPanel').style.display = 'none';
    setBallsDisabled(false);
  }

  function setBallsDisabled(disabled){
    document.querySelectorAll('.ball-btn').forEach(btn=>{
      if(disabled){
        btn.disabled = true;
      } else {
        // restore normal rule: red is only enabled while reds remain
        btn.disabled = (btn.dataset.ball === 'red' && state.redsLeft <= 0);
      }
    });
  }

  // ---------- LIVE COMMENTS + REACTIONS ----------
  function spawnFloatingEmoji(emoji){
    const layer = document.getElementById('reactionsLayer');
    if(!layer || !emoji) return;
    const el = document.createElement('span');
    el.className = 'floating-emoji';
    el.textContent = emoji;
    const leftPct = 4 + Math.random()*88;        // spread across the full width, like rain
    const drift = Math.round(Math.random()*60 - 30) + 'px';
    const size = (1.2 + Math.random()*0.9).toFixed(2) + 'rem';
    const duration = (2.6 + Math.random()*1.4).toFixed(2) + 's';
    el.style.left = leftPct + '%';
    el.style.fontSize = size;
    el.style.setProperty('--drift', drift);
    el.style.animationDuration = duration;
    layer.appendChild(el);
    const cleanup = ()=> el.remove();
    el.addEventListener('animationend', cleanup);
    setTimeout(cleanup, 4500); // fallback in case animationend doesn't fire
  }

  // A single tap drops a little shower of the same emoji, staggered slightly,
  // rather than just one drop — reads more like rain.
  function spawnEmojiRain(emoji){
    const drops = 5 + Math.floor(Math.random()*3); // 5-7 drops
    for(let i=0;i<drops;i++){
      setTimeout(()=> spawnFloatingEmoji(emoji), i * (70 + Math.random()*90));
    }
  }

  function sendReaction(emoji){
    if(!state) return;
    const id = Date.now() + '-' + Math.random().toString(36).slice(2,7);
    spawnEmojiRain(emoji); // optimistic local animation
    lastAnimatedReactionId = id; // don't re-animate when our own write echoes back
    state.reaction = {id, emoji};
    if(!applyingRemote) pushCommentOrReaction();
  }

  function submitComment(){
    const textInput = document.getElementById('commentTextInput');
    const nameInput = document.getElementById('commentNameInput');
    if(!state || !textInput) return;
    const text = textInput.value.trim();
    if(!text) return;
    myName = nameInput.value.trim().slice(0,16) || 'Guest';
    try{ localStorage.setItem('snookerCommenterName', myName); } catch(e){ /* storage unavailable */ }

    if(!Array.isArray(state.comments)) state.comments = [];
    state.comments.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2,7),
      name: myName,
      text: text.slice(0,140),
      accent: myAccent,
      ts: Date.now()
    });
    // hard cap so the synced payload can't balloon between prune sweeps
    if(state.comments.length > 40) state.comments.shift();
    textInput.value = '';
    processComments();
    if(!applyingRemote) pushCommentOrReaction();
  }

  // Pops up a bubble for a comment, lets it sit for COMMENT_DISPLAY_MS, then
  // fades it out and removes it from the DOM — nothing lingers on screen.
  function spawnCommentBubble(comment){
    const layer = document.getElementById('commentsPopupLayer');
    if(!layer || !comment) return;
    const el = document.createElement('div');
    el.className = 'comment-bubble';
    el.innerHTML = `<span class="comment-name" style="color:${comment.accent || 'var(--brass)'}">${escapeHtml(comment.name || 'Guest')}</span>${escapeHtml(comment.text)}`;
    el.style.animationDuration = (COMMENT_DISPLAY_MS/1000) + 's';
    layer.appendChild(el);
    while(layer.children.length > 4) layer.removeChild(layer.firstChild); // keep the stack short
    const cleanup = ()=> el.remove();
    el.addEventListener('animationend', cleanup);
    setTimeout(cleanup, COMMENT_DISPLAY_MS + 400); // fallback in case animationend doesn't fire
  }

  // Finds comments this device hasn't popped up yet and animates them in.
  // Comments already stale by the time we see them (e.g. just joined the
  // room) are marked seen without animating, so nothing flashes on arrival.
  function processComments(){
    if(!state || !Array.isArray(state.comments)) return;
    const now = Date.now();
    state.comments.forEach(c=>{
      if(shownCommentIds.has(c.id)) return;
      shownCommentIds.add(c.id);
      const age = now - (c.ts || now);
      if(age < COMMENT_DISPLAY_MS) spawnCommentBubble(c);
    });
    if(shownCommentIds.size > 300){
      const stillPresent = new Set(state.comments.map(c=>c.id));
      shownCommentIds.forEach(id=>{ if(!stillPresent.has(id)) shownCommentIds.delete(id); });
    }
  }

  // ---------- RENDER ----------
  function render(){
    const grid = document.getElementById('scorecardsGrid');
    grid.innerHTML = '';
    state.competitors.forEach((c, i)=>{
      const accent = ACCENTS[i % ACCENTS.length];
      const card = document.createElement('div');
      card.className = 'card' + (state.turn === i ? ' active' : '');
      card.style.setProperty('--accent', accent);
      card.style.borderColor = state.turn === i ? accent : 'transparent';
      card.innerHTML = `
        <div class="turn-tag" style="background:${accent}; opacity:${state.turn===i?1:0}">On break</div>
        <div class="name">${escapeHtml(c.name)}</div>
        ${c.members ? `<div class="members">${escapeHtml(c.members.join(' & '))}</div>` : ''}
        <div class="score">${c.score}</div>
        <div class="frames">Frames: ${c.frames}</div>
        <div class="break">Break <b>${c.curBreak}</b> · Best <b>${c.bestBreak}</b></div>
      `;
      card.addEventListener('click', ()=> selectTurn(i));
      grid.appendChild(card);
    });

    document.getElementById('redsLeft').textContent = state.redsLeft;
    document.querySelector('.ball-btn.red').disabled = state.redsLeft <= 0;

    const phaseLabel = document.getElementById('phaseLabel');
    if(state.redsLeft > 0){
      phaseLabel.textContent = 'Reds & colours';
    } else {
      const next = COLOUR_ORDER[state.colourStage];
      phaseLabel.textContent = 'Next colour: ' + next.charAt(0).toUpperCase() + next.slice(1);
    }

    renderHistory();
    processComments();

    // Animate any reaction that hasn't been shown on this device yet
    // (covers reactions arriving from other devices in the same room).
    if(state.reaction && state.reaction.id !== lastAnimatedReactionId){
      lastAnimatedReactionId = state.reaction.id;
      spawnEmojiRain(state.reaction.emoji);
    }

    if(!applyingRemote) saveState();
  }

  function renderHistory(){
    const list = document.getElementById('historyList');
    if(!state.log.length){
      list.innerHTML = '<div class="history-empty">No actions yet — start potting!</div>';
      return;
    }
    list.innerHTML = state.log.slice().reverse().map(item=>{
      const dot = item.accent ? `<span class="h-dot" style="background:${item.accent}"></span>` : '';
      const val = item.val ? `<span class="h-val">${escapeHtml(item.val)}</span>` : '';
      return `<div class="history-item"><span>${dot}${escapeHtml(item.text)}</span>${val}</div>`;
    }).join('');
  }

  function escapeHtml(str){
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ---------- EVENTS ----------
  document.querySelectorAll('.ball-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(btn.disabled) return;
      potBall(btn.dataset.ball);
    });
  });
  document.getElementById('switchBtn').addEventListener('click', switchTurn);
  document.getElementById('undoBtn').addEventListener('click', undo);
  document.getElementById('endFrameBtn').addEventListener('click', endFrame);
  document.getElementById('newFrameBtn').addEventListener('click', newFrame);
  document.getElementById('newMatchBtn').addEventListener('click', newMatch);
  document.getElementById('resetRedBtn').addEventListener('click', ()=>{
    if(isViewer) return;
    snapshot();
    state.redsLeft = Math.min(15, state.redsLeft + 1);
    pushLog('Red ball placed back on table', '', null);
    render();
  });
  document.getElementById('clearHistoryBtn').addEventListener('click', ()=>{
    if(isViewer) return;
    if(!state.log.length) return;
    snapshot();
    state.log = [];
    render();
  });
  document.getElementById('copyCodeBtn').addEventListener('click', ()=>{
    if(displayCode && !isViewer && navigator.clipboard) navigator.clipboard.writeText(displayCode).catch(()=>{});
  });
  document.getElementById('copyViewCodeBtn').addEventListener('click', ()=>{
    const code = isViewer ? displayCode : currentViewCode;
    if(code && navigator.clipboard) navigator.clipboard.writeText(code).catch(()=>{});
  });

  const foulPanel = document.getElementById('foulPanel');
  document.getElementById('foulBtn').addEventListener('click', ()=>{
    if(isViewer) return;
    if(foulPanel.style.display === 'none'){
      foulPanel.style.display = 'block';
      setBallsDisabled(true);
    } else {
      closeFoulPanel();
    }
  });
  document.querySelectorAll('.fval-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const val = parseInt(btn.dataset.foul, 10);
      awardFoul(val);
    });
  });

  // Comments + emoji reactions — available to owner and viewers alike
  document.querySelectorAll('.emoji-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> sendReaction(btn.dataset.emoji));
  });
  document.getElementById('commentSendBtn').addEventListener('click', submitComment);
  document.getElementById('commentTextInput').addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){ e.preventDefault(); submitComment(); }
  });
  document.getElementById('commentNameInput').addEventListener('change', ()=>{
    const nameInput = document.getElementById('commentNameInput');
    myName = nameInput.value.trim().slice(0,16);
    try{ localStorage.setItem('snookerCommenterName', myName); } catch(e){ /* storage unavailable */ }
  });

})();