// Popup script for BrowserMCP Enhanced

document.addEventListener('DOMContentLoaded', function() {
  const statusDiv = document.getElementById('status');
  const connectButton = document.getElementById('connect');
  const multiInstanceToggle = document.getElementById('multi-instance-toggle');
  const unsafeModeToggle = document.getElementById('unsafe-mode-toggle');
  const instancesContainer = document.getElementById('instances-container');
  const instancesList = document.getElementById('instances-list');
  const warningDiv = document.getElementById('multi-instance-warning');

  // Server config elements
  const serverHostInput = document.getElementById('server-host');
  const serverPortInput = document.getElementById('server-port');
  const saveServerConfigButton = document.getElementById('save-server-config');
  const currentServerSpan = document.getElementById('current-server');

  // Load current settings
  chrome.storage.local.get(['multiInstance', 'unsafeMode', 'browsermcp_server_host', 'browsermcp_server_port'], (result) => {
    multiInstanceToggle.checked = result.multiInstance === true;
    unsafeModeToggle.checked = result.unsafeMode === true;

    // Load server config
    const serverHost = result.browsermcp_server_host || 'localhost';
    const serverPort = result.browsermcp_server_port || 8765;

    serverHostInput.value = serverHost;
    serverPortInput.value = serverPort;
    currentServerSpan.textContent = `${serverHost}:${serverPort}`;

    if (result.multiInstance) {
      checkMultiInstanceStatus();
    } else {
      checkLegacyStatus();
    }
  });

  // Track last known error to persist it
  let lastKnownError = null;

  // Track current server being connected to
  let currentConnectingServer = null;

  // Check legacy connection status
  function checkLegacyStatus() {
    chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
      if (chrome.runtime.lastError) {
        statusDiv.className = 'status disconnected';
        statusDiv.textContent = 'Extension error';
        connectButton.disabled = true;
        return;
      }

      if (response && response.connected) {
        statusDiv.className = 'status connected';
        // Show the server we're actually connected to
        const displayHost = response.serverHost || 'localhost';
        const displayPort = response.serverPort || 8765;
        statusDiv.textContent = `Connected to ${displayHost}:${displayPort}`;
        connectButton.textContent = 'Reconnect';
        lastKnownError = null; // Clear error when connected
        currentConnectingServer = null; // Clear connecting state
      } else {
        statusDiv.className = 'status disconnected';

        // Update last known error if we have a new one
        if (response && response.lastError) {
          lastKnownError = response.lastError;
        }

        // Always show the last known error (persists across refreshes)
        if (lastKnownError) {
          statusDiv.innerHTML = `
            <strong>Connection Error</strong><br>
            <small style="color: #a94442;">${lastKnownError}</small>
          `;
        } else {
          statusDiv.textContent = 'Disconnected';
        }
        connectButton.textContent = 'Connect';
      }
    });
  }

  // Check multi-instance status
  function checkMultiInstanceStatus() {
    chrome.runtime.sendMessage({ type: 'status' }, (response) => {
      if (chrome.runtime.lastError) {
        statusDiv.className = 'status disconnected';
        statusDiv.textContent = 'Extension error';
        connectButton.disabled = true;
        return;
      }

      if (response && response.instances) {
        const instanceCount = response.instances.length;

        if (instanceCount > 0) {
          statusDiv.className = 'status multi-instance';
          statusDiv.textContent = `Multi-Instance: ${instanceCount} connection${instanceCount > 1 ? 's' : ''}`;
          connectButton.textContent = 'Connect Current Tab';

          // Show instances list
          instancesContainer.style.display = 'block';
          instancesList.innerHTML = '';

          response.instances.forEach(instance => {
            const item = document.createElement('div');
            item.className = 'instance-item';
            item.innerHTML = `
              Instance: ${instance.id.substring(0, 8)}...
              <span class="port-badge">Port ${instance.port}</span>
              <br>
              <small>Connected: ${instance.connectedAt}</small>
            `;
            instancesList.appendChild(item);
          });

          // Show tab locks if any
          if (response.tabLocks && response.tabLocks.length > 0) {
            const locksHeader = document.createElement('div');
            locksHeader.innerHTML = '<strong>Tab Locks:</strong>';
            locksHeader.style.marginTop = '10px';
            instancesList.appendChild(locksHeader);

            response.tabLocks.forEach(([tabId, instanceId]) => {
              const lockItem = document.createElement('div');
              lockItem.className = 'instance-item';
              lockItem.innerHTML = `Tab ${tabId} locked by ${instanceId.substring(0, 8)}...`;
              instancesList.appendChild(lockItem);
            });
          }
        } else {
          statusDiv.className = 'status disconnected';
          statusDiv.textContent = 'No instances connected';
          connectButton.textContent = 'Waiting for connections...';
          instancesContainer.style.display = 'none';
        }
      } else if (response && response.mode === 'legacy') {
        checkLegacyStatus();
      }
    });
  }

  // Connect button handler
  connectButton.addEventListener('click', function() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.runtime.sendMessage({
          type: 'connect',
          tabId: tabs[0].id
        }, (response) => {
          if (response && response.success) {
            statusDiv.className = 'status connected';
            statusDiv.textContent = 'Connected to current tab';
            setTimeout(() => {
              if (multiInstanceToggle.checked) {
                checkMultiInstanceStatus();
              } else {
                checkLegacyStatus();
              }
            }, 1000);
          }
        });
      }
    });
  });

  // Multi-instance toggle handler
  multiInstanceToggle.addEventListener('change', function() {
    const enabled = this.checked;
    chrome.storage.local.set({ multiInstance: enabled }, () => {
      console.log('Multi-instance mode:', enabled);
      warningDiv.style.display = 'block';

      // Reload extension to apply changes
      setTimeout(() => {
        chrome.runtime.reload();
      }, 2000);
    });
  });

  // Unsafe mode toggle handler
  unsafeModeToggle.addEventListener('change', function() {
    const enabled = this.checked;
    chrome.storage.local.set({ unsafeMode: enabled }, () => {
      console.log('Unsafe mode:', enabled);
    });
  });

  // Save server config handler
  saveServerConfigButton.addEventListener('click', function() {
    const host = serverHostInput.value.trim() || 'localhost';
    const port = parseInt(serverPortInput.value) || 8765;

    // Validate port
    if (port < 1 || port > 65535) {
      alert('Invalid port number. Must be between 1 and 65535.');
      return;
    }

    // Save to storage
    chrome.storage.local.set({
      browsermcp_server_host: host,
      browsermcp_server_port: port
    }, () => {
      console.log('Server config saved:', host, port);
      currentServerSpan.textContent = `${host}:${port}`;

      // Clear last known error on new connection attempt
      lastKnownError = null;
      currentConnectingServer = `${host}:${port}`;

      // Notify background to reload config
      chrome.runtime.sendMessage({ type: 'reloadServerConfig' }, (response) => {
        if (response && response.success) {
          statusDiv.className = 'status disconnected';
          statusDiv.textContent = `Connecting to ${host}:${port}...`;

          // Check status after giving it time to connect/fail
          setTimeout(() => {
            if (multiInstanceToggle.checked) {
              checkMultiInstanceStatus();
            } else {
              checkLegacyStatus();
            }
          }, 2500); // Increased from 1500ms to give more time
        }
      });
    });
  });

  // Refresh status periodically
  setInterval(() => {
    if (multiInstanceToggle.checked) {
      checkMultiInstanceStatus();
    } else {
      checkLegacyStatus();
    }
  }, 2000);
});