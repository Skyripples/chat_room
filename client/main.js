const MESSAGE_MAX_CHARS = 100;
const CLIENT_ID_STORAGE_KEY = "anonymousChatClientId";
const THEME_STORAGE_KEY = "anonymousChatTheme";
const socketOptions = {};
const socketUrl = (() => {
  const hostname = window.location.hostname;

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return undefined;
  }

  if (hostname === "skyripples.github.io") {
    socketOptions.path = "/chat-socket.io/";
    return "https://api.jiangshemg.space";
  }

  return undefined;
})();
const socket = socketUrl ? io(socketUrl, socketOptions) : io();

const nameModal = document.getElementById("nameModal");
const nameForm = document.getElementById("nameForm");
const nameInput = document.getElementById("nameInput");
const roomModal = document.getElementById("roomModal");
const roomForm = document.getElementById("roomForm");
const roomNameInput = document.getElementById("roomNameInput");
const roomPasswordToggle = document.getElementById("roomPasswordToggle");
const roomPasswordInput = document.getElementById("roomPasswordInput");
const roomLimitToggle = document.getElementById("roomLimitToggle");
const roomLimitInput = document.getElementById("roomLimitInput");
const cancelRoomButton = document.getElementById("cancelRoomButton");
const createRoomButton = document.getElementById("createRoomButton");
const themeToggleButton = document.getElementById("themeToggleButton");
const roomList = document.getElementById("roomList");
const roomTitle = document.getElementById("roomTitle");
const roomStatus = document.getElementById("roomStatus");
const messageList = document.getElementById("messageList");
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const privateBar = document.getElementById("privateBar");
const privateTargetText = document.getElementById("privateTargetText");
const clearPrivateButton = document.getElementById("clearPrivateButton");
const memberList = document.getElementById("memberList");
const memberCount = document.getElementById("memberCount");

let username = "";
let selfId = "";
let currentRoomId = "";
let rooms = [];
let roomUsers = [];
let privateTarget = null;
let clientUserId = getClientUserId();
let currentTheme = getInitialTheme();
const memberNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

applyTheme(currentTheme);

function getClientUserId() {
  const existingId = localStorage.getItem(CLIENT_ID_STORAGE_KEY);

  if (existingId) return existingId;

  const nextId =
    window.crypto?.randomUUID?.() ??
    `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  localStorage.setItem(CLIENT_ID_STORAGE_KEY, nextId);
  return nextId;
}

function getInitialTheme() {
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);

  if (savedTheme === "dark" || savedTheme === "light") {
    return savedTheme;
  }

  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches
    ? "dark"
    : "light";
}

function applyTheme(theme) {
  currentTheme = theme;
  document.body.dataset.theme = theme;
  localStorage.setItem(THEME_STORAGE_KEY, theme);

  if (themeToggleButton) {
    themeToggleButton.textContent = theme === "dark" ? "淺色模式" : "深色模式";
    themeToggleButton.setAttribute(
      "aria-label",
      theme === "dark" ? "切換為淺色模式" : "切換為深色模式",
    );
  }
}

function countChars(text) {
  return Array.from(text).length;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setInputEnabled(enabled) {
  messageInput.disabled = !enabled;
  sendButton.disabled = !enabled;
}

function updateReadyState() {
  const hasName = username.length > 0;
  const hasRoom = currentRoomId.length > 0;

  if (!socket.connected) {
    roomStatus.textContent = "連線中...";
  } else if (!hasName) {
    roomStatus.textContent = "請先輸入暱稱";
  } else if (!hasRoom) {
    roomStatus.textContent = "請選擇聊天室";
  } else {
    const room = rooms.find((item) => item.id === currentRoomId);
    const count = room?.userCount ?? 0;
    const maxUsers = room?.maxUsers ?? 100;

    roomStatus.textContent = `${count}/${maxUsers} 人在線`;
  }

  setInputEnabled(socket.connected && hasName && hasRoom);
}

function setPrivateTarget(user) {
  privateTarget = user;

  if (!privateTarget) {
    privateBar.classList.add("hidden");
    messageInput.placeholder = "輸入訊息...";
    return;
  }

  privateTargetText.textContent = `正在私訊 ${privateTarget.username}`;
  privateBar.classList.remove("hidden");
  messageInput.placeholder = `私訊 ${privateTarget.username}...`;
  messageInput.focus();
}

function appendSystemMessage(text) {
  const row = document.createElement("div");

  row.className = "system-message";
  row.textContent = text;

  messageList.appendChild(row);
  messageList.scrollTop = messageList.scrollHeight;
}

function appendMessage(message) {
  if (!message.text) return;

  const isMe = message.senderId === selfId || message.sender === username;
  const row = document.createElement("div");
  const privateLabel = message.isPrivate
    ? `<div class="private-label">${
        isMe
          ? `私訊給 ${escapeHtml(message.recipientName)}`
          : `${escapeHtml(message.sender)} 私訊你`
      }</div>`
    : "";

  row.className = `message-row ${isMe ? "me" : "other"} ${
    message.isPrivate ? "private" : ""
  }`;
  row.innerHTML = `
    <div class="message-bubble">
      ${privateLabel}
      <div><strong>${escapeHtml(message.sender)}</strong></div>
      <div>${escapeHtml(message.text)}</div>
      <div class="message-time">${escapeHtml(message.time)}</div>
    </div>
  `;

  messageList.appendChild(row);
  messageList.scrollTop = messageList.scrollHeight;
}

function sortRoomUsersForDisplay(nextUsers) {
  return [...nextUsers].sort((first, second) => {
    const firstIsSelf = first.id === selfId;
    const secondIsSelf = second.id === selfId;

    if (firstIsSelf && !secondIsSelf) return -1;
    if (!firstIsSelf && secondIsSelf) return 1;

    return (
      memberNameCollator.compare(first.username, second.username) ||
      first.id.localeCompare(second.id)
    );
  });
}

function joinRoom(room) {
  let password = "";

  if (room.id === currentRoomId) return;

  if (room.isPrivate) {
    password = window.prompt(`請輸入「${room.name}」的密碼`) ?? "";
  }

  socket.emit("join-room", { roomId: room.id, password }, (response) => {
    if (!response?.ok) {
      window.alert(response?.error ?? "無法加入聊天室");
    }
  });
}

function deleteRoom(room) {
  const confirmed = window.confirm(
    `確定要刪除「${room.name}」嗎？\n聊天室與其中的公開訊息會一起刪除。`,
  );

  if (!confirmed) return;

  socket.emit("delete-room", { roomId: room.id }, (response) => {
    if (!response?.ok) {
      window.alert(response?.error ?? "無法刪除聊天室");
    }
  });
}

function renderRooms() {
  roomList.innerHTML = "";

  rooms.forEach((room) => {
    const item = document.createElement("div");
    const openButton = document.createElement("button");
    const label = room.name.slice(0, 1) || "聊";

    item.className = `room-item ${room.id === currentRoomId ? "active" : ""}`;
    openButton.type = "button";
    openButton.className = "room-open-button";
    openButton.innerHTML = `
      <span class="avatar">${escapeHtml(label)}</span>
      <span class="room-info">
        <span class="room-name">${escapeHtml(room.name)}</span>
        <span class="room-meta">${room.isPrivate ? "私人聊天室" : "公開聊天室"} · ${room.userCount}/${room.maxUsers} 人</span>
      </span>
    `;
    openButton.addEventListener("click", () => joinRoom(room));

    item.appendChild(openButton);

    if (room.canDelete) {
      const deleteButton = document.createElement("button");

      deleteButton.type = "button";
      deleteButton.className = "room-delete-button";
      deleteButton.textContent = "刪除";
      deleteButton.addEventListener("click", () => deleteRoom(room));
      item.appendChild(deleteButton);
    }

    roomList.appendChild(item);
  });
}

function renderMembers() {
  memberList.innerHTML = "";
  memberCount.textContent = `${roomUsers.length} 人在線`;

  sortRoomUsersForDisplay(roomUsers).forEach((user) => {
    const isSelf = user.id === selfId;
    const button = document.createElement("button");

    button.type = "button";
    button.className = `member-item ${isSelf ? "self" : ""} ${
      privateTarget?.id === user.id ? "active" : ""
    }`;
    button.disabled = isSelf;
    button.innerHTML = `
      <span class="member-avatar">${escapeHtml(user.username.slice(0, 1) || "匿")}</span>
      <span class="member-name">${escapeHtml(user.username)}${isSelf ? "（你）" : ""}</span>
      <span class="member-action">${isSelf ? "" : "私訊"}</span>
    `;

    button.addEventListener("click", () => {
      setPrivateTarget(user);
      renderMembers();
    });

    memberList.appendChild(button);
  });
}

function handleSendFailure(response, originalText) {
  messageInput.value = response?.rejectedText ?? originalText;
  window.alert(response?.error ?? "訊息送出失敗");
  messageInput.focus();
}

nameForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const value = nameInput.value.trim();

  if (!value) return;

  socket.emit(
    "register-user",
    {
      username: value,
      clientUserId,
    },
    (response) => {
      if (!response?.ok) {
        window.alert(response?.error ?? "無法進入聊天室");
        return;
      }

      username = value;
      selfId = response.userId;
      nameModal.classList.add("hidden");
      updateReadyState();
      messageInput.focus();
    },
  );
});

createRoomButton.addEventListener("click", () => {
  if (!username) {
    window.alert("請先輸入暱稱");
    return;
  }

  roomForm.reset();
  roomPasswordInput.disabled = true;
  roomPasswordInput.required = false;
  roomPasswordInput.value = "";
  roomLimitInput.disabled = true;
  roomLimitInput.value = "100";
  roomModal.classList.remove("hidden");
  roomNameInput.focus();
});

cancelRoomButton.addEventListener("click", () => {
  roomModal.classList.add("hidden");
});

themeToggleButton.addEventListener("click", () => {
  applyTheme(currentTheme === "dark" ? "light" : "dark");
});

roomPasswordToggle.addEventListener("change", () => {
  roomPasswordInput.disabled = !roomPasswordToggle.checked;
  roomPasswordInput.required = roomPasswordToggle.checked;

  if (roomPasswordToggle.checked) {
    roomPasswordInput.focus();
  } else {
    roomPasswordInput.value = "";
  }
});

roomLimitToggle.addEventListener("change", () => {
  roomLimitInput.disabled = !roomLimitToggle.checked;

  if (roomLimitToggle.checked) {
    roomLimitInput.focus();
  } else {
    roomLimitInput.value = "100";
  }
});

roomForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const limitEnabled = roomLimitToggle.checked;
  const maxUsers = Number(roomLimitInput.value);
  const passwordEnabled = roomPasswordToggle.checked;
  const password = roomPasswordInput.value.trim();

  if (passwordEnabled && !password) {
    window.alert("請輸入聊天室密碼");
    roomPasswordInput.focus();
    return;
  }

  if (limitEnabled && (!Number.isInteger(maxUsers) || maxUsers < 2 || maxUsers > 100)) {
    window.alert("人數限制必須介於 2 到 100 人");
    roomLimitInput.focus();
    return;
  }

  socket.emit(
    "create-room",
    {
      name: roomNameInput.value.trim(),
      password: passwordEnabled ? password : "",
      passwordEnabled,
      limitEnabled,
      maxUsers,
    },
    (response) => {
      if (!response?.ok) {
        window.alert(response?.error ?? "無法建立聊天室");
        return;
      }

      roomModal.classList.add("hidden");
      messageInput.focus();
    },
  );
});

clearPrivateButton.addEventListener("click", () => {
  setPrivateTarget(null);
  renderMembers();
});

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const originalText = messageInput.value;
  const text = originalText.trim();

  if (!text || !username || !socket.connected || !currentRoomId) return;

  if (countChars(text) > MESSAGE_MAX_CHARS) {
    window.alert(`每則訊息最多 ${MESSAGE_MAX_CHARS} 個字，請刪減後再送出。`);
    messageInput.value = originalText;
    messageInput.focus();
    return;
  }

  sendButton.disabled = true;

  if (privateTarget) {
    socket.emit(
      "private-message",
      {
        targetUserId: privateTarget.id,
        text: originalText,
      },
      (response) => {
        if (!response?.ok) {
          handleSendFailure(response, originalText);
        } else {
          messageInput.value = "";
        }

        updateReadyState();
      },
    );
  } else {
    socket.emit("chat-message", { text: originalText }, (response) => {
      if (!response?.ok) {
        handleSendFailure(response, originalText);
      } else {
        messageInput.value = "";
      }

      updateReadyState();
    });
  }
});

socket.on("connect", () => {
  updateReadyState();
});

socket.on("disconnect", () => {
  setInputEnabled(false);
  roomStatus.textContent = "連線中斷，重新連線中...";
});

socket.on("room-list", (nextRooms) => {
  rooms = nextRooms;
  renderRooms();
  updateReadyState();
});

socket.on("room-joined", (room) => {
  currentRoomId = room.id;
  roomTitle.textContent = room.name;
  messageList.innerHTML = "";
  setPrivateTarget(null);
  renderRooms();
  updateReadyState();
});

socket.on("room-history", (messages) => {
  messageList.innerHTML = "";
  messages.forEach(appendMessage);
});

socket.on("room-users", (users) => {
  roomUsers = users;

  if (privateTarget && !roomUsers.some((user) => user.id === privateTarget.id)) {
    setPrivateTarget(null);
  }

  renderMembers();
  updateReadyState();
});

socket.on("room-deleted", (room) => {
  appendSystemMessage(`「${room.roomName}」已被刪除，你已回到公開聊天室`);
});

socket.on("system-message", (text) => {
  appendSystemMessage(text);
});

socket.on("chat-message", (message) => {
  appendMessage(message);
});

updateReadyState();
nameInput.focus();
