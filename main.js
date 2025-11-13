const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');

const expressApp = express();
let server = http.createServer(expressApp);
let io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = 3001;
let mainWindow;
let rendererWindow = null; // Window для WebRTC в renderer process
const activeStreams = new Map(); // displayId -> { clients: Set, stream: MediaStream }
let serverRunning = false;
let serverSettings = {
  resolution: null, // null = native
  bitrate: 1500000, // 1.5 Mbps
  fps: 30
};

// Disable security warnings
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

// Get local IP
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return 'localhost';
}

// Update main window UI
function updateMainWindowUI() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const localIP = getLocalIP();
    const url = `http://${localIP}:${PORT}`;
    mainWindow.webContents.send('server-started', url);
  }
}

// Get correct path for files (works in both dev and production)
function getFilePath(filename) {
  // In production, files are in the app.asar or app directory
  const appPath = app.getAppPath();
  const filePath = path.join(appPath, filename);
  
  // Check if file exists, if not try resourcesPath
  try {
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  } catch (e) {
    // Ignore
  }
  
  // Fallback to __dirname
  return path.join(__dirname, filename);
}

// Create main window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 650,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const mainWindowPath = getFilePath('main-window.html');
  console.log('Loading main window from:', mainWindowPath);
  mainWindow.loadFile(mainWindowPath);
  
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Main window loaded');
    if (serverRunning) {
      updateMainWindowUI();
    }
  });
  
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load main window:', errorCode, errorDescription);
  });
}

// Create renderer window for WebRTC
function createRendererWindow() {
  if (rendererWindow && !rendererWindow.isDestroyed()) {
    return rendererWindow;
  }

  rendererWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    }
  });

  const rendererPath = getFilePath('renderer.html');
  console.log('Loading renderer from:', rendererPath);
  rendererWindow.loadFile(rendererPath);
  
  rendererWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load renderer:', errorCode, errorDescription);
  });
  
  rendererWindow.on('closed', () => {
    rendererWindow = null;
  });

  return rendererWindow;
}

// Wait for renderer window to be ready
async function waitForRendererReady() {
  const win = createRendererWindow();
  return new Promise((resolve) => {
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => {
        // Give it a bit more time to initialize
        setTimeout(resolve, 200);
      });
    } else {
      setTimeout(resolve, 200);
    }
  });
}

// Get public directory path (works in both dev and production)
function getPublicPath() {
  const appPath = app.getAppPath();
  const publicPath = path.join(appPath, 'public');
  
  // Check if directory exists
  try {
    if (fs.existsSync(publicPath)) {
      return publicPath;
    }
  } catch (e) {
    // Ignore
  }
  
  // Fallback to __dirname
  return path.join(__dirname, 'public');
}

// Serve static files
const publicPath = getPublicPath();
console.log('Serving static files from:', publicPath);
expressApp.use(express.static(publicPath));

// Serve WebRTC client by default
expressApp.get('/', (req, res) => {
  const indexPath = path.join(publicPath, 'index.html');
  console.log('Serving index.html from:', indexPath);
  res.sendFile(indexPath);
});

// Serve favicon
expressApp.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// API endpoint to get list of displays
expressApp.get('/api/displays', async (req, res) => {
  try {
    if (!app.isReady()) {
      return res.status(503).json({ error: 'App not ready yet' });
    }

    // Get real displays from screen API
    const allDisplays = screen.getAllDisplays();
    // Filter out built-in/internal displays, keep only virtual/external displays
    const realDisplays = allDisplays.filter(display => {
      // On macOS, internal displays have display.internal === true
      // Virtual displays (from BetterDisplay) are usually external (internal === false)
      return display.internal === false;
    });
    console.log(`Found ${allDisplays.length} total displays, ${realDisplays.length} virtual displays (excluding built-in)`);
    
    // Get all screen sources from desktopCapturer
    const allSources = await desktopCapturer.getSources({ 
      types: ['screen'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false
    });
    
    console.log(`Found ${allSources.length} screen sources from desktopCapturer`);
    
    // Match real displays with sources
    // On macOS, source.id format is "screen:displayId:index" or "screen:displayId"
    const displays = [];
    const usedSourceIds = new Set();
    
    // Log all displays and sources for debugging
    console.log('=== Real Displays ===');
    realDisplays.forEach((d, i) => {
      console.log(`Display ${i}: id=${d.id}, label="${d.label || 'N/A'}", bounds=${JSON.stringify(d.bounds)}`);
    });
    console.log('=== Screen Sources ===');
    allSources.forEach((s, i) => {
      console.log(`Source ${i}: id="${s.id}", name="${s.name}"`);
    });
    
    for (const display of realDisplays) {
      // Try to find matching source for this display
      // Source ID format on macOS: "screen:displayId:index" or "screen:displayId:0"
      const displayIdStr = String(display.id);
      
      // Find source that matches this display ID
      let matchedSource = null;
      let matchMethod = 'none';
      
      // First, try exact match by display ID in source ID
      for (const source of allSources) {
        // Extract display ID from source ID (format: "screen:displayId:index")
        const sourceIdParts = source.id.split(':');
        if (sourceIdParts.length >= 2 && sourceIdParts[0] === 'screen') {
          const sourceDisplayId = sourceIdParts[1];
          if (sourceDisplayId === displayIdStr && !usedSourceIds.has(source.id)) {
            matchedSource = source;
            usedSourceIds.add(source.id);
            matchMethod = 'exact';
            console.log(`✓ Matched Display ${display.id} (${display.label || 'N/A'}) with source "${source.id}" (exact match)`);
            break;
          }
        }
      }
      
      // If no exact match found, try to match by source name containing display info
      if (!matchedSource) {
        for (const source of allSources) {
          if (!usedSourceIds.has(source.id)) {
            // Check if source name contains display label or ID
            const sourceNameLower = source.name.toLowerCase();
            const displayLabelLower = (display.label || '').toLowerCase();
            if (displayLabelLower && sourceNameLower.includes(displayLabelLower)) {
              matchedSource = source;
              usedSourceIds.add(source.id);
              matchMethod = 'name';
              console.log(`✓ Matched Display ${display.id} (${display.label || 'N/A'}) with source "${source.id}" (name match)`);
              break;
            }
          }
        }
      }
      
      // If still no match, use first unused source (fallback)
      if (!matchedSource) {
        for (const source of allSources) {
          if (!usedSourceIds.has(source.id)) {
            matchedSource = source;
            usedSourceIds.add(source.id);
            matchMethod = 'fallback';
            console.log(`⚠ Matched Display ${display.id} (${display.label || 'N/A'}) with source "${source.id}" (fallback - may be incorrect!)`);
            break;
          }
        }
      }
      
      if (matchedSource) {
        // Create display name from display info
        const displayName = display.label || 
                           `Display ${display.id}` + 
                           (display.bounds.width && display.bounds.height 
                             ? ` (${display.bounds.width}x${display.bounds.height})` 
                             : '');
        
        displays.push({
          id: matchedSource.id, // Use source ID for capturing
          name: displayName,
          thumbnail: matchedSource.thumbnail.toDataURL(),
          displayId: display.id, // Store real display ID for reference
          bounds: display.bounds
        });
        
        console.log(`  → Using source ID: "${matchedSource.id}" for display "${displayName}"`);
      } else {
        console.warn(`✗ No source found for display ${display.id} (${display.label || 'N/A'})`);
      }
    }
    
    console.log(`=== Final Result: ${displays.length} displays matched ===`);
    displays.forEach((d, i) => {
      console.log(`Display ${i}: "${d.name}" → source ID: "${d.id}"`);
    });
    
    res.json({ displays });
  } catch (error) {
    console.error('Error getting displays:', error);
    res.status(500).json({ 
      error: error.message,
      details: 'Make sure Screen Recording permission is granted in System Preferences'
    });
  }
});

// Socket.IO setup is now in setupSocketIO function

// IPC handlers
ipcMain.on('webrtc-signal-from-renderer', (event, data) => {
  // Forward signal to Socket.IO
  io.to(data.roomId).emit('webrtc-signal', data);
});

// Start server handler
ipcMain.on('start-server', async (event, settings) => {
  if (serverRunning) {
    console.log('Server already running');
    return;
  }
  
  // Update settings
  serverSettings = settings || serverSettings;
  console.log('Starting server with settings:', serverSettings);
  
  // Recreate renderer window to ensure clean state
  if (rendererWindow && !rendererWindow.isDestroyed()) {
    try {
      rendererWindow.close();
    } catch (e) {
      console.error('Error closing renderer window:', e);
    }
    rendererWindow = null;
  }
  
  // Wait a bit before creating new renderer window
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Create fresh renderer window and send settings
  try {
    await waitForRendererReady();
    const rendererWin = createRendererWindow();
    if (rendererWin && !rendererWin.isDestroyed() && !rendererWin.webContents.isDestroyed()) {
      // Wait for renderer to fully initialize
      await new Promise(resolve => setTimeout(resolve, 500));
      try {
        rendererWin.webContents.send('update-default-settings', serverSettings);
        console.log('Sent default settings to renderer:', serverSettings);
      } catch (error) {
        console.error('Error sending settings to renderer:', error);
      }
    }
  } catch (error) {
    console.error('Error creating renderer window:', error);
  }
  
  // Start server if not already listening
  if (!server.listening) {
    server.listen(PORT, '0.0.0.0', () => {
      serverRunning = true;
      const localIP = getLocalIP();
      console.log(`Server started on http://${localIP}:${PORT}`);
      updateMainWindowUI();
      
      // Notify renderer that server started
      setTimeout(() => {
        if (rendererWindow && !rendererWindow.isDestroyed() && !rendererWindow.webContents.isDestroyed()) {
          try {
            rendererWindow.webContents.send('server-started');
            console.log('Sent server-started to renderer');
          } catch (error) {
            console.error('Error sending server-started to renderer:', error);
          }
        }
      }, 1000);
    });
  } else {
    serverRunning = true;
    updateMainWindowUI();
    
    // Notify renderer that server started
    setTimeout(() => {
      if (rendererWindow && !rendererWindow.isDestroyed() && !rendererWindow.webContents.isDestroyed()) {
        try {
          rendererWindow.webContents.send('server-started');
          console.log('Sent server-started to renderer');
        } catch (error) {
          console.error('Error sending server-started to renderer:', error);
        }
      }
    }, 1000);
  }
});

// Stop server handler
ipcMain.on('stop-server', () => {
  if (!serverRunning) {
    console.log('Server not running');
    return;
  }
  
  console.log('Stopping server...');
  
  // Stop all active streams in renderer
  if (rendererWindow && !rendererWindow.isDestroyed() && !rendererWindow.webContents.isDestroyed()) {
    try {
      rendererWindow.webContents.send('stop-all-streams');
      console.log('Sent stop-all-streams to renderer');
    } catch (error) {
      console.error('Error sending stop-all-streams to renderer:', error);
    }
  }
  
  // Close all Socket.IO connections
  try {
    io.sockets.emit('server-stopping');
    io.disconnectSockets();
    io.close();
  } catch (error) {
    console.error('Error closing Socket.IO:', error);
  }
  
  // Stop HTTP server
  server.close(() => {
    serverRunning = false;
    console.log('Server stopped');
    
    // Recreate server and Socket.IO for next start
    server = http.createServer(expressApp);
    io = new Server(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });
    
    // Re-setup Socket.IO handlers
    setupSocketIO(io);
    
    // Close renderer window to ensure clean state
    if (rendererWindow && !rendererWindow.isDestroyed()) {
      try {
        rendererWindow.close();
      } catch (error) {
        console.error('Error closing renderer window:', error);
      }
      rendererWindow = null;
    }
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server-stopped');
    }
  });
});

// Setup Socket.IO handlers
function setupSocketIO(socketIO) {
  socketIO.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    let currentDisplayId = null;
    let roomId = null;

    socket.on('join-room', (data) => {
      // Prevent duplicate joins
      if (roomId === data.roomId && currentDisplayId === data.displayId) {
        console.log(`Socket ${socket.id} already in room ${data.roomId}, ignoring duplicate join`);
        socket.emit('joined', { roomId: data.roomId, displayId: data.displayId });
                return;
              }
              
      roomId = data.roomId;
      currentDisplayId = data.displayId;
      socket.join(roomId);
      console.log(`Socket ${socket.id} joined room ${roomId} for display ${currentDisplayId}`);
      
      // Check if this is a browser client (not renderer)
      if (socket.handshake.headers['user-agent'] && !socket.handshake.headers['user-agent'].includes('Electron')) {
        // This is a browser client
        console.log(`Browser client ${socket.id} joined, starting WebRTC`);
        
        // Wait for renderer to be ready, then notify it to start WebRTC
        waitForRendererReady().then(() => {
          const rendererWin = createRendererWindow();
          if (rendererWin && !rendererWin.isDestroyed() && !rendererWin.webContents.isDestroyed()) {
            try {
              rendererWin.webContents.send('start-webrtc', {
                displayId: currentDisplayId,
                roomId: roomId,
                socketId: socket.id
              });
              console.log(`Sent start-webrtc to renderer for displayId: "${currentDisplayId}", roomId: "${roomId}"`);
          } catch (error) {
              console.error('Error sending start-webrtc to renderer:', error);
            }
          } else {
            console.error('Renderer window is not available');
          }
        }).catch(error => {
          console.error('Error waiting for renderer ready:', error);
        });
      } else {
        // This is renderer
        console.log(`Renderer ${socket.id} joined room`);
      }
      
      socket.emit('joined', { roomId, displayId: currentDisplayId });
    });

    socket.on('webrtc-signal', (data) => {
      // Forward WebRTC signaling data to other clients in the room (not back to sender)
      console.log('Forwarding WebRTC signal in room:', data.roomId, 'from:', data.socketId);
      // Only forward to other clients, not back to sender
      socket.to(data.roomId).emit('webrtc-signal', data);
    });

    socket.on('update-settings', (data) => {
      console.log('Received settings update:', data);
      // Forward settings update to renderer
      const rendererWin = createRendererWindow();
      if (rendererWin && !rendererWin.isDestroyed() && !rendererWin.webContents.isDestroyed()) {
        try {
          rendererWin.webContents.send('update-settings', {
            displayId: data.displayId,
            roomId: data.roomId,
            resolution: data.resolution,
            bitrate: data.bitrate,
            fps: data.fps
          });
          console.log('Sent settings update to renderer');
        } catch (error) {
          console.error('Error sending settings update to renderer:', error);
        }
      }
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
      if (currentDisplayId && roomId) {
        const rendererWin = createRendererWindow();
        if (rendererWin && !rendererWin.isDestroyed() && !rendererWin.webContents.isDestroyed()) {
          try {
            rendererWin.webContents.send('stop-webrtc', {
              displayId: currentDisplayId,
              roomId: roomId
            });
          } catch (error) {
            console.error('Error sending stop-webrtc to renderer:', error);
          }
        }
      }
    });
  });
}

// Initial Socket.IO setup
setupSocketIO(io);

// Start app
app.whenReady().then(() => {
  app.setName('Screen Streaming Server');
  
  console.log('App ready, creating windows...');
  
  // Pre-create renderer window so it's ready when clients connect
  try {
    createRendererWindow();
    console.log('Renderer window created');
  } catch (error) {
    console.error('Error creating renderer window:', error);
  }
  
  // Create main window (server not started by default)
  try {
    createWindow();
    console.log('Main window created');
  } catch (error) {
    console.error('Error creating main window:', error);
  }

  app.on('activate', () => {
    console.log('App activated');
    if (BrowserWindow.getAllWindows().length === 0) {
      try {
      createWindow();
      } catch (error) {
        console.error('Error creating window on activate:', error);
      }
    }
  });
  
  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  console.log('Shutting down server...');
  if (rendererWindow) {
    rendererWindow.close();
  }
  server.close();
});

