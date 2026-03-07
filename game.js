// ============================================================
// Blanc Manger Coco — P2P Multiplayer with PeerJS
// ============================================================

(function () {
    "use strict";

    // --- Constants ---
    const HAND_SIZE = 7;
    const ROOM_PREFIX = "bmc-coco-";

    // --- State ---
    let peer = null;
    let connections = {};  // peerId -> DataConnection (host only)
    let hostConn = null;   // DataConnection to host (guest only)
    let isHost = false;
    let myId = "";
    let myName = "Joueur";
    let roomCode = "";

    // Game state (host is source of truth)
    let gameState = {
        players: [],       // { id, name, score, hand, playedCard }
        questionDeck: [],
        answerDeck: [],
        currentQuestion: "",
        judgeIndex: 0,
        round: 1,
        pointsToWin: 5,
        phase: "lobby",    // lobby | select | judge | result | gameover
        playedCards: [],    // { playerId, card }
    };

    // Local state
    let myHand = [];
    let selectedCard = null;

    // --- DOM refs ---
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

    // --- Utilities ---
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

    // --- PeerJS setup ---
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
    // HOST LOGIC
    // ============================================================

    async function createRoom() {
        roomCode = generateRoomCode();
        const peerId = ROOM_PREFIX + roomCode;
        try {
            peer = await createPeer(peerId);
        } catch (err) {
            // If ID taken, retry once
            roomCode = generateRoomCode();
            try {
                peer = await createPeer(ROOM_PREFIX + roomCode);
            } catch (e) {
                showError("menu-error", "Impossible de créer la partie. Réessaie.");
                return;
            }
        }
        isHost = true;
        myId = peer.id;

        // Add self as player
        gameState.players = [{ id: myId, name: myName, score: 0, hand: [], playedCard: null }];

        showScreen("lobby");
        $("lobby-room-code").textContent = roomCode;
        $("lobby-host-controls").classList.remove("hidden");
        $("lobby-guest-msg").classList.add("hidden");
        updateLobbyPlayerList();

        // Listen for connections
        peer.on("connection", (conn) => {
            conn.on("open", () => {
                connections[conn.peer] = conn;
                const newPlayer = { id: conn.peer, name: "Joueur", score: 0, hand: [], playedCard: null };
                gameState.players.push(newPlayer);
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
        // Send personalized state to each player (with their own hand)
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

        // Played cards: only reveal when phase is judge or result
        let played = [];
        if (gameState.phase === "judge" || gameState.phase === "result") {
            played = gameState.playedCards.map((pc) => {
                if (gameState.phase === "result") {
                    return { card: pc.card, playerId: pc.playerId, playerName: gameState.players.find(p => p.id === pc.playerId)?.name };
                }
                return { card: pc.card }; // anonymous during judging
            });
        }

        const submittedCount = gameState.playedCards.length;
        const expectedCount = gameState.players.length - 1; // minus judge

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
            submittedCount,
            expectedCount,
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
                    const cardIndex = p.hand.indexOf(data.card);
                    if (cardIndex !== -1) {
                        p.playedCard = data.card;
                        p.hand.splice(cardIndex, 1);
                        gameState.playedCards.push({ playerId: peerId, card: data.card });

                        // Check if all non-judge players have played
                        const expected = gameState.players.length - 1;
                        if (gameState.playedCards.length >= expected) {
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
            case "next-round": {
                // Only host triggers this, ignore from guests
                break;
            }
        }
    }

    function hostStartGame() {
        const pts = parseInt($("input-points-to-win").value) || 5;
        gameState.pointsToWin = pts;
        gameState.round = 1;
        gameState.judgeIndex = 0;
        gameState.players.forEach((p) => { p.score = 0; p.hand = []; p.playedCard = null; });

        // Prepare decks
        gameState.questionDeck = shuffle(QUESTION_CARDS);
        gameState.answerDeck = shuffle(ANSWER_CARDS);

        // Deal hands
        for (const p of gameState.players) {
            p.hand = dealCards(HAND_SIZE);
        }

        startRound();
    }

    function dealCards(n) {
        const cards = [];
        for (let i = 0; i < n; i++) {
            if (gameState.answerDeck.length === 0) {
                gameState.answerDeck = shuffle(ANSWER_CARDS);
            }
            cards.push(gameState.answerDeck.pop());
        }
        return cards;
    }

    function startRound() {
        // Draw question
        if (gameState.questionDeck.length === 0) {
            gameState.questionDeck = shuffle(QUESTION_CARDS);
        }
        gameState.currentQuestion = gameState.questionDeck.pop();
        gameState.playedCards = [];
        gameState.winnerInfo = null;
        gameState.players.forEach((p) => { p.playedCard = null; });
        gameState.phase = "select";
        broadcastState();
    }

    function resolveRound(winnerPlayerId) {
        const winner = gameState.players.find((p) => p.id === winnerPlayerId);
        const winningEntry = gameState.playedCards.find((pc) => pc.playerId === winnerPlayerId);
        if (!winner || !winningEntry) return;

        winner.score++;
        gameState.winnerInfo = { id: winner.id, name: winner.name, card: winningEntry.card };

        // Refill hands
        for (const p of gameState.players) {
            while (p.hand.length < HAND_SIZE) {
                if (gameState.answerDeck.length === 0) {
                    gameState.answerDeck = shuffle(ANSWER_CARDS);
                }
                p.hand.push(gameState.answerDeck.pop());
            }
        }

        // Check win condition
        if (winner.score >= gameState.pointsToWin) {
            gameState.phase = "gameover";
        } else {
            gameState.phase = "result";
        }
        broadcastState();
    }

    function hostNextRound() {
        gameState.round++;
        gameState.judgeIndex = (gameState.judgeIndex + 1) % gameState.players.length;
        startRound();
    }

    // ============================================================
    // GUEST LOGIC
    // ============================================================

    async function joinRoom(code) {
        roomCode = code.toUpperCase().trim();
        const hostPeerId = ROOM_PREFIX + roomCode;

        try {
            peer = await createPeer(undefined); // auto-generated ID
        } catch (err) {
            showError("menu-error", "Erreur de connexion. Réessaie.");
            return;
        }
        myId = peer.id;

        const conn = peer.connect(hostPeerId, { reliable: true });
        hostConn = conn;

        conn.on("open", () => {
            showScreen("lobby");
            $("lobby-room-code").textContent = roomCode;
            $("lobby-host-controls").classList.add("hidden");
            $("lobby-guest-msg").classList.remove("hidden");

            conn.on("data", (data) => {
                if (data.type === "state") {
                    handleClientState(data.state);
                }
            });

            conn.on("close", () => {
                showError("lobby-error", "Déconnecté de l'hôte.");
                showScreen("menu");
            });

            // Send name
            if (myName !== "Joueur") {
                conn.send({ type: "set-name", name: myName });
            }
        });

        conn.on("error", () => {
            showError("menu-error", "Partie introuvable. Vérifie le code.");
        });

        // Timeout
        setTimeout(() => {
            if (!conn.open) {
                showError("menu-error", "Impossible de se connecter. Vérifie le code.");
                if (peer) peer.destroy();
            }
        }, 8000);
    }

    function sendToHost(data) {
        if (isHost) {
            handleHostMessage(myId, data);
        } else if (hostConn && hostConn.open) {
            hostConn.send(data);
        }
    }

    // ============================================================
    // CLIENT RENDERING (both host and guests)
    // ============================================================

    let currentClientState = null;

    function handleClientState(state) {
        currentClientState = state;
        myHand = state.hand;

        // Update player list in lobby
        updateLobbyFromState(state);

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

    function updateLobbyPlayerList() {
        const list = $("player-list");
        list.innerHTML = "";
        gameState.players.forEach((p) => {
            const li = document.createElement("li");
            li.innerHTML = `<span>${escapeHtml(p.name)}</span>`;
            if (p.id === gameState.players[0]?.id) {
                li.innerHTML += `<span class="host-badge">Hôte</span>`;
            }
            list.appendChild(li);
        });
        $("player-count").textContent = gameState.players.length;

        const btn = $("btn-start-game");
        if (btn) {
            btn.disabled = gameState.players.length < 3;
            btn.textContent = gameState.players.length < 3
                ? `Lancer la partie (min. 3 joueurs)`
                : `Lancer la partie !`;
        }
    }

    function updateLobbyFromState(state) {
        const list = $("player-list");
        list.innerHTML = "";
        state.players.forEach((p, i) => {
            const li = document.createElement("li");
            li.innerHTML = `<span>${escapeHtml(p.name)}</span>`;
            if (i === 0) {
                li.innerHTML += `<span class="host-badge">Hôte</span>`;
            }
            if (state.phase !== "lobby") {
                li.innerHTML += `<span class="score-badge">${p.score} pt${p.score > 1 ? "s" : ""}</span>`;
            }
            list.appendChild(li);
        });
        $("player-count").textContent = state.players.length;
    }

    function renderGame(state) {
        // Round info
        $("game-round").textContent = `Tour ${state.round}`;
        $("game-judge").textContent = `Juge : ${escapeHtml(state.judgeName)}`;

        // Question card
        const qText = state.currentQuestion.replace(/____/g, '<span class="blank">________</span>');
        $("question-text").innerHTML = qText;

        // Scoreboard
        const sbList = $("scoreboard-list");
        sbList.innerHTML = "";
        state.players.sort((a, b) => b.score - a.score).forEach((p) => {
            const li = document.createElement("li");
            li.innerHTML = `<span>${escapeHtml(p.name)}${p.id === state.judgeId ? " (Juge)" : ""}</span><span>${p.score} pt${p.score > 1 ? "s" : ""}</span>`;
            sbList.appendChild(li);
        });

        // Hide all phases
        $("phase-select").classList.add("hidden");
        $("phase-waiting").classList.add("hidden");
        $("phase-judge").classList.add("hidden");
        $("phase-judge-waiting").classList.add("hidden");
        $("phase-result").classList.add("hidden");

        const amJudge = state.judgeId === myId;

        if (state.phase === "select") {
            if (amJudge) {
                // Judge waits
                $("phase-judge-waiting").classList.remove("hidden");
                $("judge-waiting-count").textContent = state.submittedCount;
                $("judge-waiting-total").textContent = state.expectedCount;
            } else if (state.hasPlayed) {
                // Already played, waiting
                $("phase-waiting").classList.remove("hidden");
                $("waiting-count").textContent = state.submittedCount;
                $("waiting-total").textContent = state.expectedCount;
            } else {
                // Show hand
                $("phase-select").classList.remove("hidden");
                renderHand(state.hand);
            }
        } else if (state.phase === "judge") {
            if (amJudge) {
                // Judge picks
                $("phase-judge").classList.remove("hidden");
                renderJudgeCards(state.playedCards);
            } else {
                // Waiting for judge
                $("phase-waiting").classList.remove("hidden");
                $("waiting-count").textContent = state.expectedCount;
                $("waiting-total").textContent = state.expectedCount;
                $("phase-waiting").querySelector(".phase-instruction").textContent =
                    `${escapeHtml(state.judgeName)} choisit la meilleure réponse...`;
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
            div.className = "card answer-card";
            div.textContent = card;
            div.addEventListener("click", () => {
                if (selectedCard === card) {
                    // Confirm play
                    sendToHost({ type: "play-card", card });
                } else {
                    // Select
                    container.querySelectorAll(".answer-card").forEach((c) => c.classList.remove("selected"));
                    div.classList.add("selected");
                    selectedCard = card;
                }
            });
            container.appendChild(div);
        });
    }

    function renderJudgeCards(playedCards) {
        const container = $("judge-cards");
        container.innerHTML = "";
        playedCards.forEach((pc) => {
            const div = document.createElement("div");
            div.className = "card answer-card";
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
        state.players.sort((a, b) => b.score - a.score).forEach((p) => {
            const li = document.createElement("li");
            li.innerHTML = `<span>${escapeHtml(p.name)}</span><span class="score-badge">${p.score} pts</span>`;
            list.appendChild(li);
        });
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    // ============================================================
    // EVENT LISTENERS
    // ============================================================

    // Menu
    $("btn-create").addEventListener("click", () => {
        $("join-form").classList.add("hidden");
        createRoom();
    });

    $("btn-join").addEventListener("click", () => {
        $("join-form").classList.toggle("hidden");
    });

    $("btn-join-confirm").addEventListener("click", () => {
        const code = $("input-room-code").value.trim();
        if (code.length < 3) {
            showError("menu-error", "Entre un code valide.");
            return;
        }
        joinRoom(code);
    });

    $("input-room-code").addEventListener("keydown", (e) => {
        if (e.key === "Enter") $("btn-join-confirm").click();
    });

    // Lobby
    $("btn-copy-code").addEventListener("click", () => {
        navigator.clipboard.writeText(roomCode).then(() => {
            $("btn-copy-code").textContent = "Copié";
            setTimeout(() => ($("btn-copy-code").textContent = "Copier"), 1500);
        });
    });

    $("btn-share").addEventListener("click", () => {
        const text = "Rejoins ma partie Blanc Manger Coco ! Code : " + roomCode;
        const url = window.location.href;
        if (navigator.share) {
            navigator.share({ title: "Blanc Manger Coco", text, url }).catch(() => {});
        } else {
            navigator.clipboard.writeText(text + "\n" + url).then(() => {
                $("btn-share").textContent = "Copié";
                setTimeout(() => ($("btn-share").textContent = "Partager"), 1500);
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
        if (isHost && gameState.players.length >= 3) {
            hostStartGame();
        }
    });

    // Game
    $("btn-toggle-scores").addEventListener("click", () => {
        $("scoreboard-panel").classList.toggle("hidden");
    });

    $("btn-next-round").addEventListener("click", () => {
        if (isHost) hostNextRound();
    });

    // Game over
    $("btn-new-game").addEventListener("click", () => {
        if (isHost) {
            gameState.phase = "lobby";
            broadcastState();
        }
        showScreen("lobby");
    });
})();
