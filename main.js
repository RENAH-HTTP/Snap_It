// main.js
// This is the Electron "main process". It runs in Node.js and is responsible
// for creating the application window and managing the app's lifecycle.
// The actual UI (HTML/CSS/JS) runs in a separate "renderer process".

const { app, BrowserWindow } = require('electron');
const path = require('path');

// Keep a global reference to the window so it doesn't get garbage-collected.
let mainWindow;

function createWindow() {
  // Create the browser window that will display index.html.
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'Snap-It',
    webPreferences: {
      // nodeIntegration + contextIsolation:false keeps things simple for
      // beginners — the renderer can use require() directly. For a
      // production app you'd want a preload script with contextIsolation:true.
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Load the main HTML file into the window.
  mainWindow.loadFile('index.html');

  // Uncomment the next line to open Chrome DevTools automatically on launch.
  // mainWindow.webContents.openDevTools();

  // Clean up when the window is closed.
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Electron is ready — create the window.
app.whenReady().then(createWindow);

// Quit when all windows are closed (except on macOS where apps usually
// stay running until the user explicitly quits with Cmd+Q).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// On macOS, re-create a window when the dock icon is clicked and no
// other windows are open.
app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
