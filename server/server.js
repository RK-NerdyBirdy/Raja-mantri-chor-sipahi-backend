const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);

// CORS configuration
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? ["*"] // For Vercel deployment, you can restrict this to your domain later
      : ["http://localhost:3000", "http://127.0.0.1:3000"],
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Game state management
const rooms = new Map();
const players = new Map();

// Character definitions
const CHARACTERS = {
  'Raja': { points: 2000, emoji: '👑' },
  'Mantri': { points: 900, emoji: '🎭' },
  'Chor': { points: 0, emoji: '🗡️' },
  'Sipahi': { points: 700, emoji: '🛡️' }
};

// Utility functions
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function shuffleArray(array) {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}

function createRoom(hostId, hostData) {
  let roomCode;
  do {
    roomCode = generateRoomCode();
  } while (rooms.has(roomCode));
  
  const room = {
    code: roomCode,
    hostId: hostId,
    players: new Map(),
    gameState: {
      status: 'waiting', // waiting, playing, finished
      currentRound: 1,
      totalRounds: hostData.rounds || 5,
      characters: {},
      scores: {},
      sipahiId: null,
      chorId: null,
      currentGuess: null,
      roundResults: null
    },
    settings: {
      maxPlayers: 4,
      rounds: hostData.rounds || 5
    }
  };
  
  // Add host as first player
  room.players.set(hostId, {
    id: hostId,
    name: hostData.name,
    avatar: hostData.avatar,
    isHost: true,
    isReady: true
  });
  
  room.gameState.scores[hostId] = 0;
  rooms.set(roomCode, room);
  return room;
}

function assignCharacters(room) {
  const playerIds = Array.from(room.players.keys());
  const characters = ['Raja', 'Mantri', 'Chor', 'Sipahi'];
  const shuffledCharacters = shuffleArray(characters);
  
  playerIds.forEach((playerId, index) => {
    const character = shuffledCharacters[index] || characters[index % characters.length];
    room.gameState.characters[playerId] = character;
    
    if (character === 'Sipahi') {
      room.gameState.sipahiId = playerId;
    } else if (character === 'Chor') {
      room.gameState.chorId = playerId;
    }
  });
}

function calculateRoundResults(room, suspectedPlayerId) {
  const sipahiId = room.gameState.sipahiId;
  const chorId = room.gameState.chorId;
  const isCorrectGuess = suspectedPlayerId === chorId;
  
  const results = {
    sipahiId,
    chorId,
    suspectedPlayerId,
    isCorrectGuess,
    pointChanges: {}
  };
  
  // Initialize point changes
  Array.from(room.players.keys()).forEach(playerId => {
    results.pointChanges[playerId] = 0;
  });
  
  if (isCorrectGuess) {
    // Correct guess: Sipahi keeps points, others get their base points
    results.pointChanges[sipahiId] = CHARACTERS['Sipahi'].points;
    results.pointChanges[chorId] = CHARACTERS['Chor'].points;
  } else {
    // Wrong guess: Sipahi and Chor switch points
    results.pointChanges[sipahiId] = CHARACTERS['Chor'].points;
    results.pointChanges[chorId] = CHARACTERS['Sipahi'].points;
  }
  
  // Award points to Raja and Mantri
  Object.entries(room.gameState.characters).forEach(([playerId, character]) => {
    if (character === 'Raja') {
      results.pointChanges[playerId] = CHARACTERS['Raja'].points;
    } else if (character === 'Mantri') {
      results.pointChanges[playerId] = CHARACTERS['Mantri'].points;
    }
  });
  
  // Update actual scores
  Object.entries(results.pointChanges).forEach(([playerId, points]) => {
    room.gameState.scores[playerId] = (room.gameState.scores[playerId] || 0) + points;
  });
  
  return results;
}

// Socket connection handling
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);
  
  // Store player reference
  players.set(socket.id, {
    id: socket.id,
    roomCode: null
  });

  // Create room
  socket.on('create-room', (data) => {
    try {
      const room = createRoom(socket.id, data);
      socket.join(room.code);
      players.get(socket.id).roomCode = room.code;
      
      socket.emit('room-created', {
        success: true,
        roomCode: room.code,
        players: Array.from(room.players.values()),
        settings: room.settings
      });
      
      console.log(`Room created: ${room.code} by ${data.name}`);
    } catch (error) {
      console.error('Create room error:', error);
      socket.emit('error', { message: 'Failed to create room' });
    }
  });

  // Join room
  socket.on('join-room', (data) => {
    try {
      const room = rooms.get(data.roomCode);
      
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      
      if (room.players.size >= room.settings.maxPlayers) {
        socket.emit('error', { message: 'Room is full' });
        return;
      }
      
      if (room.gameState.status === 'playing') {
        socket.emit('error', { message: 'Game already in progress' });
        return;
      }
      
      // Check if name already exists
      const existingPlayer = Array.from(room.players.values()).find(p => p.name === data.name);
      if (existingPlayer) {
        socket.emit('error', { message: 'Name already taken' });
        return;
      }
      
      // Add player to room
      room.players.set(socket.id, {
        id: socket.id,
        name: data.name,
        avatar: data.avatar,
        isHost: false,
        isReady: true
      });
      
      room.gameState.scores[socket.id] = 0;
      socket.join(data.roomCode);
      players.get(socket.id).roomCode = data.roomCode;
      
      // Notify all players in room
      io.to(data.roomCode).emit('player-joined', {
        players: Array.from(room.players.values()),
        newPlayer: data.name
      });
      
      socket.emit('room-joined', {
        success: true,
        roomCode: data.roomCode,
        players: Array.from(room.players.values()),
        settings: room.settings
      });
      
      console.log(`${data.name} joined room: ${data.roomCode}`);
    } catch (error) {
      console.error('Join room error:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // Start game
  socket.on('start-game', (data) => {
    try {
      const room = rooms.get(data.roomCode);
      
      if (!room || room.hostId !== socket.id) {
        socket.emit('error', { message: 'Not authorized to start game' });
        return;
      }
      
      if (room.players.size < 2) {
        socket.emit('error', { message: 'Need at least 2 players' });
        return;
      }
      
      // Update room settings
      room.gameState.totalRounds = data.rounds || room.settings.rounds;
      room.gameState.status = 'playing';
      room.gameState.currentRound = 1;
      
      // Reset scores for new game
      room.players.forEach((player, playerId) => {
        room.gameState.scores[playerId] = 0;
      });
      
      // Start first round
      assignCharacters(room);
      
      // Send game start to all players
      io.to(data.roomCode).emit('game-started', {
        currentRound: room.gameState.currentRound,
        totalRounds: room.gameState.totalRounds
      });
      
      // Send individual character assignments
      room.players.forEach((player, playerId) => {
        io.to(playerId).emit('character-assigned', {
          character: room.gameState.characters[playerId],
          isSipahi: room.gameState.sipahiId === playerId
        });
      });
      
      console.log(`Game started in room: ${data.roomCode}`);
    } catch (error) {
      console.error('Start game error:', error);
      socket.emit('error', { message: 'Failed to start game' });
    }
  });

  // Make guess (Sipahi action)
  socket.on('make-guess', (data) => {
    try {
      const room = rooms.get(data.roomCode);
      
      if (!room || room.gameState.sipahiId !== socket.id) {
        socket.emit('error', { message: 'Not your turn or invalid room' });
        return;
      }
      
      // Calculate results
      const results = calculateRoundResults(room, data.suspectedPlayerId);
      room.gameState.roundResults = results;
      
      // Send results to all players
      io.to(data.roomCode).emit('round-results', {
        results: results,
        currentScores: room.gameState.scores,
        characters: room.gameState.characters,
        roundNumber: room.gameState.currentRound
      });
      
      console.log(`Guess made in room ${data.roomCode}: ${results.isCorrectGuess ? 'Correct' : 'Wrong'}`);
    } catch (error) {
      console.error('Make guess error:', error);
      socket.emit('error', { message: 'Failed to process guess' });
    }
  });

  // Next round
  socket.on('next-round', (data) => {
    try {
      const room = rooms.get(data.roomCode);
      
      if (!room || room.hostId !== socket.id) {
        socket.emit('error', { message: 'Not authorized' });
        return;
      }
      
      room.gameState.currentRound++;
      
      if (room.gameState.currentRound > room.gameState.totalRounds) {
        // Game finished
        room.gameState.status = 'finished';
        
        // Calculate winner
        const winner = Array.from(room.players.entries())
          .map(([id, player]) => ({
            ...player,
            score: room.gameState.scores[id] || 0
          }))
          .sort((a, b) => b.score - a.score)[0];
        
        io.to(data.roomCode).emit('game-finished', {
          winner: winner,
          finalScores: room.gameState.scores,
          players: Array.from(room.players.values())
        });
      } else {
        // Start next round
        assignCharacters(room);
        
        io.to(data.roomCode).emit('round-started', {
          currentRound: room.gameState.currentRound,
          totalRounds: room.gameState.totalRounds
        });
        
        // Send new character assignments
        room.players.forEach((player, playerId) => {
          io.to(playerId).emit('character-assigned', {
            character: room.gameState.characters[playerId],
            isSipahi: room.gameState.sipahiId === playerId
          });
        });
      }
    } catch (error) {
      console.error('Next round error:', error);
      socket.emit('error', { message: 'Failed to start next round' });
    }
  });

  // Player disconnect
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    
    const player = players.get(socket.id);
    if (player && player.roomCode) {
      const room = rooms.get(player.roomCode);
      if (room) {
        room.players.delete(socket.id);
        delete room.gameState.scores[socket.id];
        
        // Notify other players
        socket.to(player.roomCode).emit('player-left', {
          players: Array.from(room.players.values()),
          leftPlayerId: socket.id
        });
        
        // If host left, assign new host or close room
        if (room.hostId === socket.id) {
          if (room.players.size > 0) {
            const newHostId = Array.from(room.players.keys())[0];
            room.hostId = newHostId;
            room.players.get(newHostId).isHost = true;
            
            io.to(player.roomCode).emit('new-host', {
              newHostId: newHostId,
              players: Array.from(room.players.values())
            });
          } else {
            rooms.delete(player.roomCode);
            console.log(`Room ${player.roomCode} deleted - no players left`);
          }
        }
      }
    }
    
    players.delete(socket.id);
  });
});

// Serve static files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    rooms: rooms.size, 
    players: players.size,
    timestamp: new Date().toISOString()
  });
});

// Cleanup old empty rooms periodically
setInterval(() => {
  const now = Date.now();
  for (const [roomCode, room] of rooms.entries()) {
    if (room.players.size === 0) {
      rooms.delete(roomCode);
      console.log(`Cleaned up empty room: ${roomCode}`);
    }
  }
}, 300000); // Clean up every 5 minutes

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 Raja Mantri Server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});