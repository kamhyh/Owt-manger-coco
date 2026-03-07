// ============================================================
// Owt Manger Coco — P2P Multiplayer with PeerJS
// ============================================================

(function () {
    "use strict";

    const HAND_SIZE = 7;
    const ROOM_PREFIX = "bmc-coco-";
    const SESSION_KEY = "bmc-session";

    const AVATAR_COLORS = [
        "#e11d48", "#c026d3", "#7c3aed", "#2563eb",
        "#0891b2", "#059669", "#ca8a04", "#ea580c",
        "#6366f1", "#14b8a6", "#f43f5e", "#8b5cf6",
    ];

    // --- State ---
    let peer = null;
    let connections = {};
    let hostConn = null;
    let isHost = false;
    let myId = "";
    let myName = "Joueur";
    let roomCode = "";

    let gameState = {
        players: [],
        questionDeck: [],
        answerDeck: [],
        currentQuestion: "",
        judgeIndex: 0,
        round: 1,
        pointsToWin: 5,
        phase: "lobby",
        playedCards: [],
    };

    let myHand = [];
    let selectedCard = null;

    // --- DOM ---
    const $ = (id) => document.getElementById(id);

    const screens = {
        menu: $("screen-menu"),
        lobby: $("screen-lobby"),
        game: $("screen-game"),
        gameover: $("screen-gameover"),
    };

    function showScreen(name) {
        Object.values(screens).forEach((s) => s.classList.remove("active"));
        screens[name].classList.add("active");
    }

    // --- Helpers ---
    function generateRoomCode() {
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let code = "";
        for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
        return code;
    }

    function shuffle(arr) {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    function showError(elementId, msg) {
        const el = $(elementId);
        el.textContent = msg;
        el.classList.remove("hidden");
        setTimeout(() => el.classList.add("hidden"), 4000);
    }

    function escapeHtml(str) {
        const d = document.createElement("div");
        d.textContent = str;
        return d.innerHTML;
    }

    function getInitial(name) {
        return (name || "?")[0].toUpperCase();
    }

    function getAvatarColor(index) {
        return AVATAR_COLORS[index % AVATAR_COLORS.length];
    }

    function renderPips(containerId, filled, total) {
        const el = $(containerId);
        if (!el) return;
        el.innerHTML = "";
        for (let i = 0; i < total; i++) {
            const pip = document.createElement("span");
            pip.className = "pip" + (i < filled ? " pip--filled" : "");
            el.appendChild(pip);
        }
    }

    // --- PeerJS ---
    function createPeer(id) {
        return new Promise((resolve, reject) => {
            const p = new Peer(id, {
                debug: 0,
                config: {
                    iceServers: [
                        { urls: "stun:stun.l.google.com:19302" },
                        { urls: "stun:stun1.l.google.com:19302" },
                    ],
                },
            });
            p.on("open", () => resolve(p));
            p.on("error", (err) => reject(err));
        });
    }

    // ============================================================
    // HOST
    // ============================================================

    async function createRoom() {
        roomCode = generateRoomCode();
        try {
            peer = await createPeer(ROOM_PREFIX + roomCode);
        } catch (_) {
            roomCode = generateRoomCode();
            try {
                peer = await createPeer(ROOM_PREFIX + roomCode);
            } catch (__) {
                showError("menu-error", "Impossible de creer la partie. Reessaie.");
                return;
            }
        }
        isHost = true;
        myId = peer.id;
        gameState.players = [{ id: myId, name: myName, score: 0, hand: [], playedCard: null }];

        showScreen("lobby");
        $("lobby-room-code").textContent = roomCode;
        window.location.hash = roomCode;
        $("lobby-host-controls").classList.remove("hidden");
        $("lobby-guest-msg").classList.add("hidden");
        updateLobbyPlayerList();

        peer.on("connection", (conn) => {
            conn.on("open", () => {
                connections[conn.peer] = conn;
                gameState.players.push({ id: conn.peer, name: "Joueur", score: 0, hand: [], playedCard: null });
                updateLobbyPlayerList();
                broadcastState();
                conn.on("data", (data) => handleHostMessage(conn.peer, data));
                conn.on("close", () => removePlayer(conn.peer));
            });
        });
    }

    function removePlayer(peerId) {
        delete connections[peerId];
        gameState.players = gameState.players.filter((p) => p.id !== peerId);
        updateLobbyPlayerList();
        broadcastState();
    }

    function broadcastState() {
        for (const p of gameState.players) {
            const state = buildClientState(p.id);
            if (p.id === myId) {
                handleClientState(state);
            } else if (connections[p.id]) {
                connections[p.id].send({ type: "state", state });
            }
        }
    }

    function buildClientState(playerId) {
        const player = gameState.players.find((p) => p.id === playerId);
        const judge = gameState.players[gameState.judgeIndex];

        let played = [];
        if (gameState.phase === "judge" || gameState.phase === "result") {
            played = gameState.playedCards.map((pc) => {
                if (gameState.phase === "result") {
                    return { card: pc.card, playerId: pc.playerId, playerName: gameState.players.find(p => p.id === pc.playerId)?.name };
                }
                return { card: pc.card };
            });
        }

        return {
            phase: gameState.phase,
            players: gameState.players.map((p) => ({ id: p.id, name: p.name, score: p.score })),
            hand: player ? player.hand : [],
            currentQuestion: gameState.currentQuestion,
            judgeId: judge ? judge.id : "",
            judgeName: judge ? judge.name : "",
            round: gameState.round,
            pointsToWin: gameState.pointsToWin,
            playedCards: played,
            submittedCount: gameState.playedCards.length,
            expectedCount: gameState.players.length - 1,
            hasPlayed: player ? player.playedCard !== null : false,
            winnerInfo: gameState.winnerInfo || null,
        };
    }

    function handleHostMessage(peerId, data) {
        switch (data.type) {
            case "set-name": {
                const p = gameState.players.find((pl) => pl.id === peerId);
                if (p) {
                    p.name = data.name.substring(0, 20) || "Joueur";
                    updateLobbyPlayerList();
                    broadcastState();
                }
                break;
            }
            case "play-card": {
                const p = gameState.players.find((pl) => pl.id === peerId);
                if (p && gameState.phase === "select" && !p.playedCard) {
                    const idx = p.hand.indexOf(data.card);
                    if (idx !== -1) {
                        p.playedCard = data.card;
                        p.hand.splice(idx, 1);
                        gameState.playedCards.push({ playerId: peerId, card: data.card });
                        if (gameState.playedCards.length >= gameState.players.length - 1) {
                            gameState.phase = "judge";
                            gameState.playedCards = shuffle(gameState.playedCards);
                        }
                        broadcastState();
                    }
                }
                break;
            }
            case "judge-pick": {
                if (gameState.phase === "judge" && peerId === gameState.players[gameState.judgeIndex]?.id) {
                    resolveRound(data.playerId);
                }
                break;
            }
        }
    }

    function hostStartGame() {
        gameState.pointsToWin = parseInt($("input-points-to-win").value) || 5;
        gameState.round = 1;
        gameState.judgeIndex = 0;
        gameState.players.forEach((p) => { p.score = 0; p.hand = []; p.playedCard = null; });
        gameState.questionDeck = shuffle(QUESTION_CARDS);
        gameState.answerDeck = shuffle(ANSWER_CARDS);
        for (const p of gameState.players) p.hand = dealCards(HAND_SIZE);
        startRound();
    }

    function dealCards(n) {
        const cards = [];
        for (let i = 0; i < n; i++) {
            if (gameState.answerDeck.length === 0) gameState.answerDeck = shuffle(ANSWER_CARDS);
            cards.push(gameState.answerDeck.pop());
        }
        return cards;
    }

    function startRound() {
        if (gameState.questionDeck.length === 0) gameState.questionDeck = shuffle(QUESTION_CARDS);
        gameState.currentQuestion = gameState.questionDeck.pop();
        gameState.playedCards = [];
        gameState.winnerInfo = null;
        gameState.players.forEach((p) => { p.playedCard = null; });
        gameState.phase = "select";
        broadcastState();
    }

    function resolveRound(winnerPlayerId) {
        const winner = gameState.players.find((p) => p.id === winnerPlayerId);
        const entry = gameState.playedCards.find((pc) => pc.playerId === winnerPlayerId);
        if (!winner || !entry) return;

        winner.score++;
        gameState.winnerInfo = { id: winner.id, name: winner.name, card: entry.card };

        for (const p of gameState.players) {
            while (p.hand.length < HAND_SIZE) {
                if (gameState.answerDeck.length === 0) gameState.answerDeck = shuffle(ANSWER_CARDS);
                p.hand.push(gameState.answerDeck.pop());
            }
        }

        gameState.phase = winner.score >= gameState.pointsToWin ? "gameover" : "result";
        broadcastState();
    }

    function hostNextRound() {
        gameState.round++;
        gameState.judgeIndex = (gameState.judgeIndex + 1) % gameState.players.length;
        startRound();
    }

    // ============================================================
    // GUEST
    // ============================================================

    async function joinRoom(code) {
        roomCode = code.toUpperCase().trim();
        try {
            peer = await createPeer(undefined);
        } catch (_) {
            showError("menu-error", "Erreur de connexion.");
            return;
        }
        myId = peer.id;

        const conn = peer.connect(ROOM_PREFIX + roomCode, { reliable: true });
        hostConn = conn;

        conn.on("open", () => {
            showScreen("lobby");
            $("lobby-room-code").textContent = roomCode;
            $("lobby-host-controls").classList.add("hidden");
            $("lobby-guest-msg").classList.remove("hidden");

            conn.on("data", (data) => {
                if (data.type === "state") handleClientState(data.state);
            });
            conn.on("close", () => {
                showError("lobby-error", "Deconnecte.");
                showScreen("menu");
            });
            if (myName !== "Joueur") conn.send({ type: "set-name", name: myName });
        });

        conn.on("error", () => showError("menu-error", "Partie introuvable."));

        setTimeout(() => {
            if (!conn.open) {
                showError("menu-error", "Connexion impossible. Verifie le code.");
                if (peer) peer.destroy();
            }
        }, 8000);
    }

    function sendToHost(data) {
        if (isHost) handleHostMessage(myId, data);
        else if (hostConn && hostConn.open) hostConn.send(data);
    }

    // ============================================================
    // CLIENT RENDERING
    // ============================================================

    let currentClientState = null;

    function handleClientState(state) {
        currentClientState = state;
        myHand = state.hand;
        updatePlayerListFromState(state);

        switch (state.phase) {
            case "lobby":
                if (!screens.lobby.classList.contains("active")) showScreen("lobby");
                break;
            case "select":
            case "judge":
            case "result":
                showScreen("game");
                renderGame(state);
                break;
            case "gameover":
                showGameOver(state);
                break;
        }
    }

    // --- Player list rendering (shared) ---
    function renderPlayerItem(p, index, showScore) {
        const li = document.createElement("li");
        const avatar = document.createElement("span");
        avatar.className = "avatar";
        avatar.style.background = getAvatarColor(index);
        avatar.textContent = getInitial(p.name);

        const name = document.createElement("span");
        name.className = "player-name";
        name.textContent = p.name;

        li.appendChild(avatar);
        li.appendChild(name);

        if (index === 0) {
            const badge = document.createElement("span");
            badge.className = "badge badge--host";
            badge.textContent = "Hote";
            li.appendChild(badge);
        }
        if (showScore) {
            const badge = document.createElement("span");
            badge.className = "badge badge--score";
            badge.textContent = p.score;
            li.appendChild(badge);
        }
        return li;
    }

    function updateLobbyPlayerList() {
        const list = $("player-list");
        list.innerHTML = "";
        gameState.players.forEach((p, i) => {
            list.appendChild(renderPlayerItem(p, i, false));
        });
        $("player-count").textContent = gameState.players.length;

        const btn = $("btn-start-game");
        if (btn) {
            btn.disabled = gameState.players.length < 1;
            btn.textContent = "Lancer la partie";
        }
    }

    function updatePlayerListFromState(state) {
        const list = $("player-list");
        list.innerHTML = "";
        state.players.forEach((p, i) => {
            list.appendChild(renderPlayerItem(p, i, state.phase !== "lobby"));
        });
        $("player-count").textContent = state.players.length;
    }

    // --- Game rendering ---
    function renderGame(state) {
        $("game-round").textContent = "Tour " + state.round;
        $("game-judge").textContent = "Juge : " + escapeHtml(state.judgeName);

        // Question
        $("question-text").innerHTML = state.currentQuestion.replace(
            /____/g, '<span class="blank">________</span>'
        );

        // Scoreboard
        const sbList = $("scoreboard-list");
        sbList.innerHTML = "";
        [...state.players].sort((a, b) => b.score - a.score).forEach((p) => {
            const li = document.createElement("li");
            const tag = p.id === state.judgeId ? " (juge)" : "";
            li.innerHTML = "<span>" + escapeHtml(p.name) + tag + "</span><span>" + p.score + "</span>";
            sbList.appendChild(li);
        });

        // Hide all phases
        ["phase-select", "phase-waiting", "phase-judge", "phase-judge-waiting", "phase-result"]
            .forEach((id) => $(id).classList.add("hidden"));

        const amJudge = state.judgeId === myId;

        if (state.phase === "select") {
            if (amJudge) {
                $("phase-judge-waiting").classList.remove("hidden");
                renderPips("judge-pips", state.submittedCount, state.expectedCount);
            } else if (state.hasPlayed) {
                $("phase-waiting").classList.remove("hidden");
                $("waiting-text").textContent = "Carte jouee. En attente des autres...";
                renderPips("waiting-pips", state.submittedCount, state.expectedCount);
            } else {
                $("phase-select").classList.remove("hidden");
                $("btn-confirm-card").classList.add("hidden");
                renderHand(state.hand);
            }
        } else if (state.phase === "judge") {
            if (amJudge) {
                $("phase-judge").classList.remove("hidden");
                renderJudgeCards(state.playedCards);
            } else {
                $("phase-waiting").classList.remove("hidden");
                $("waiting-text").textContent = escapeHtml(state.judgeName) + " choisit...";
                renderPips("waiting-pips", state.expectedCount, state.expectedCount);
            }
        } else if (state.phase === "result") {
            $("phase-result").classList.remove("hidden");
            if (state.winnerInfo) {
                $("result-winner-name").textContent = state.winnerInfo.name;
                $("result-card").textContent = state.winnerInfo.card;
            }
            if (isHost) {
                $("btn-next-round").classList.remove("hidden");
                $("result-wait").classList.add("hidden");
            } else {
                $("btn-next-round").classList.add("hidden");
                $("result-wait").classList.remove("hidden");
            }
        }
    }

    function renderHand(hand) {
        const container = $("hand-cards");
        container.innerHTML = "";
        selectedCard = null;

        hand.forEach((card) => {
            const div = document.createElement("div");
            div.className = "acard";
            div.textContent = card;
            div.addEventListener("click", () => {
                container.querySelectorAll(".acard").forEach((c) => c.classList.remove("acard--selected"));
                div.classList.add("acard--selected");
                selectedCard = card;
                $("btn-confirm-card").classList.remove("hidden");
            });
            container.appendChild(div);
        });
    }

    function renderJudgeCards(playedCards) {
        const container = $("judge-cards");
        container.innerHTML = "";
        playedCards.forEach((pc) => {
            const div = document.createElement("div");
            div.className = "acard";
            div.textContent = pc.card;
            div.addEventListener("click", () => {
                sendToHost({ type: "judge-pick", playerId: pc.playerId });
            });
            container.appendChild(div);
        });
    }

    function showGameOver(state) {
        showScreen("gameover");
        const winner = state.players.reduce((best, p) => (p.score > best.score ? p : best), state.players[0]);
        $("winner-name").textContent = winner.name;

        const list = $("final-scores");
        list.innerHTML = "";
        [...state.players].sort((a, b) => b.score - a.score).forEach((p, i) => {
            list.appendChild(renderPlayerItem(p, i, true));
        });
    }

    // ============================================================
    // EVENTS
    // ============================================================

    $("btn-create").addEventListener("click", () => {
        $("join-form").classList.add("hidden");
        createRoom();
    });

    $("btn-join").addEventListener("click", () => {
        $("join-form").classList.toggle("hidden");
    });

    $("btn-join-confirm").addEventListener("click", () => {
        const code = $("input-room-code").value.trim();
        if (code.length < 3) { showError("menu-error", "Code invalide."); return; }
        joinRoom(code);
    });

    $("input-room-code").addEventListener("keydown", (e) => {
        if (e.key === "Enter") $("btn-join-confirm").click();
    });

    $("btn-copy-code").addEventListener("click", () => {
        navigator.clipboard.writeText(roomCode).then(() => {
            $("btn-copy-code").textContent = "OK";
            setTimeout(() => ($("btn-copy-code").textContent = "Copier"), 1200);
        });
    });

    $("btn-share").addEventListener("click", () => {
        const shareUrl = window.location.origin + window.location.pathname + "#" + roomCode;
        const text = "Rejoins ma partie Owt Manger Coco !";
        if (navigator.share) {
            navigator.share({ title: "Owt Manger Coco", text, url: shareUrl }).catch(() => {});
        } else {
            navigator.clipboard.writeText(text + "\n" + shareUrl).then(() => {
                $("btn-share").textContent = "OK";
                setTimeout(() => ($("btn-share").textContent = "Partager"), 1200);
            });
        }
    });

    $("btn-set-name").addEventListener("click", () => {
        const name = $("input-player-name").value.trim();
        if (!name) return;
        myName = name.substring(0, 20);
        if (isHost) {
            const me = gameState.players.find((p) => p.id === myId);
            if (me) me.name = myName;
            updateLobbyPlayerList();
            broadcastState();
        } else {
            sendToHost({ type: "set-name", name: myName });
        }
    });

    $("input-player-name").addEventListener("keydown", (e) => {
        if (e.key === "Enter") $("btn-set-name").click();
    });

    $("btn-start-game").addEventListener("click", () => {
        if (isHost && gameState.players.length >= 1) hostStartGame();
    });

    $("btn-toggle-scores").addEventListener("click", () => {
        $("scoreboard-panel").classList.toggle("hidden");
    });

    $("btn-confirm-card").addEventListener("click", () => {
        if (selectedCard) {
            sendToHost({ type: "play-card", card: selectedCard });
            $("btn-confirm-card").classList.add("hidden");
        }
    });

    $("btn-next-round").addEventListener("click", () => {
        if (isHost) hostNextRound();
    });

    $("btn-new-game").addEventListener("click", () => {
        if (isHost) {
            gameState.phase = "lobby";
            broadcastState();
        }
        showScreen("lobby");
    });

    // ============================================================
    // SESSION PERSISTENCE (survive refresh)
    // ============================================================

    function saveSession() {
        try {
            sessionStorage.setItem(SESSION_KEY, JSON.stringify({
                roomCode,
                isHost,
                myName,
                ts: Date.now(),
            }));
        } catch (_) {}
    }

    function clearSession() {
        try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
    }

    function loadSession() {
        try {
            const raw = sessionStorage.getItem(SESSION_KEY);
            if (!raw) return null;
            const data = JSON.parse(raw);
            // Expire after 2 hours
            if (Date.now() - data.ts > 2 * 60 * 60 * 1000) {
                clearSession();
                return null;
            }
            return data;
        } catch (_) { return null; }
    }

    // Save session whenever state changes
    const origBroadcast = broadcastState;
    broadcastState = function () {
        origBroadcast();
        saveSession();
    };

    // Also save on guest state receive
    const origHandleClient = handleClientState;
    handleClientState = function (state) {
        origHandleClient(state);
        saveSession();
    };

    // Auto-join from URL hash (e.g. #ABC12) or reconnect from session
    (function autoConnect() {
        const hash = window.location.hash.replace("#", "").trim();

        // If URL has a room code hash, auto-join as guest
        if (hash.length >= 3) {
            window.location.hash = "";
            $("input-room-code").value = hash;
            joinRoom(hash);
            return;
        }

        // Otherwise try session reconnect
        const session = loadSession();
        if (!session) return;

        myName = session.myName || "Joueur";
        $("input-player-name").value = myName;

        if (session.isHost) {
            roomCode = session.roomCode;
            createPeer(ROOM_PREFIX + roomCode).then((p) => {
                peer = p;
                isHost = true;
                myId = peer.id;
                gameState.players = [{ id: myId, name: myName, score: 0, hand: [], playedCard: null }];

                showScreen("lobby");
                $("lobby-room-code").textContent = roomCode;
                window.location.hash = roomCode;
                $("lobby-host-controls").classList.remove("hidden");
                $("lobby-guest-msg").classList.add("hidden");
                updateLobbyPlayerList();

                peer.on("connection", (conn) => {
                    conn.on("open", () => {
                        connections[conn.peer] = conn;
                        gameState.players.push({ id: conn.peer, name: "Joueur", score: 0, hand: [], playedCard: null });
                        updateLobbyPlayerList();
                        broadcastState();
                        conn.on("data", (data) => handleHostMessage(conn.peer, data));
                        conn.on("close", () => removePlayer(conn.peer));
                    });
                });
            }).catch(() => {
                clearSession();
            });
        } else {
            joinRoom(session.roomCode);
        }
    })();
})();
